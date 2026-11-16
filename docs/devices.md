# Device migration

dolop moves Windows devices joined to Entra ID from the source tenant to the destination
tenant **without wiping them**. The user keeps their Windows profile: desktop, files, installed
apps and settings. Everything else in the source tenant (registered personal devices, Macs,
phones, stale records) is inventoried on the same page so nothing is forgotten.

There are two halves:

- **Server side (dolop):** inventory, readiness checks, BitLocker key backup, Autopilot
  removal, the optional destination provisioning package, and cleanup of source records
  afterwards.
- **On the device (the dolop agent):** a PowerShell script that hands the user's existing
  profile to their new account, leaves the source tenant and joins the destination tenant,
  either automatically with a provisioning package or with a person joining it in Settings.
  A cloud service can't do this part: it has to run on the device.

> **Test on a spare device or VM first.** The agent edits the Windows profile registry and
> profile permissions, which is the same technique commercial profile-migration tools use. It
> backs everything up and undoes the profile change automatically if something fails before
> the device leaves the source tenant, but try the whole flow on a non-critical device
> before anyone's daily laptop.

## What is supported

| Device | What dolop does |
| --- | --- |
| Windows 10/11 Pro, Enterprise or Education, **joined to Entra ID** (not hybrid) | Moved by the agent, profile kept |
| Windows, **registered** only (personal device with a work account added) | Listed as *Manual*: remove the old work account on the device, add the new one |
| Windows **hybrid joined** (on-premises AD) | Not supported by the agent (needs on-premises AD steps) |
| macOS, iOS, Android | Listed as *Manual*: re-enroll in the destination's Intune (company-owned Apple devices enrolled through Apple Business Manager need reassigning and a wipe) |
| Stale records, Intune records with no Entra device | Suggested *Clean up*: delete them from the source tenant |

Only cloud-only users are covered by the SID calculation below. For users synced from
on-premises AD, dolop uses their `onPremisesSecurityIdentifier` instead.

## Before you start

### Permissions on the source connector

Add these **application** permissions to the app the source connector uses (your multi-tenant
app for consent-link connectors, or the source tenant's own registration), then grant admin
consent again in the source tenant (for consent-link connectors: send the tenant a fresh
**Consent link** from the Connectors page).

| Permission | Used for | Without it |
| --- | --- | --- |
| `Device.ReadWrite.All` | list Entra devices; delete them during cleanup | **Required** (`Device.Read.All` works if you never use cleanup) |
| `DeviceManagementManagedDevices.ReadWrite.All` | Intune device details and primary user; delete Intune records during cleanup | Intune data is skipped |
| `DeviceManagementServiceConfig.ReadWrite.All` | find and remove Autopilot registrations | Autopilot can't be checked or removed |
| `BitLockerKey.Read.All` | back up BitLocker recovery keys | Keys can't be read from Entra (the agent still reports the keys it finds on the device) |
| `DeviceLocalCredential.ReadBasic.All` | see whether a Windows LAPS password is backed up | The local-admin readiness check shows a warning |

The destination connector needs nothing new (it already has `User.Read.All`).

### In the destination tenant

- Users are allowed to join devices to Entra ID (*Entra ID → Devices → Device settings*).
- Intune automatic enrollment (*MDM user scope*) includes the migrated users, if you want the
  devices in the destination's Intune.
- The users exist and are licensed. Provision them on the Users tab first.

### Joining the destination tenant: package or by hand

There are two ways for a device to join the destination tenant. dolop picks one automatically:

| | Provisioning package (automatic) | Manual join (no package) |
| --- | --- | --- |
| When | A `.ppkg` is uploaded on the Devices tab | No package uploaded, or the agent was run with `-ManualJoin` |
| At cutover | Unattended: the device joins and restarts by itself | Someone signs in with the local admin account and joins the device in Settings |
| MFA / Conditional Access | The package's service account can't do MFA: see the bulk-token notes below | A normal interactive sign-in, so MFA and Conditional Access work as usual |
| Best for | Many devices | A handful of devices, or when the bulk token can't be created |

**Manual join, step by step** (the device's page in dolop shows the same steps while it waits):

1. The agent hands the profile over, leaves the source tenant and restarts the device. The
   device shows **awaiting join** in dolop.
2. Sign in on the device with the **local administrator** account.
3. Open **Settings → Accounts → Access work or school → Connect**, choose **Join this device to
   Microsoft Entra ID**, and sign in as the user's new account (or a destination admin).
4. Sign out. The user signs in with their new account and gets their own desktop.
5. The agent checks every 10 minutes and finishes by itself within 10 minutes of the join
   (BitLocker backup to the new tenant, local groups), then reports **completed**. If nobody
   joins the device within 3 days it stops waiting and reports a failure.

In manual mode a working local administrator account is required (the Check fails without one),
because after the device leaves the source tenant nobody can sign in with a work account until
it is joined again.

### The provisioning package (optional)

For an unattended join, devices use a **provisioning package** containing a bulk enrollment
token. Microsoft only issues that token through an interactive admin sign-in, so you create the
package once and upload it to dolop:

1. Install **Windows Configuration Designer** from the Microsoft Store on any Windows PC.
2. Choose **Provision desktop devices**. Untick *Set up device* (so device names are kept) and
   skip *Network*.
3. Under **Account Management** choose **Enroll in Azure AD**, set the bulk token expiry (up to
   180 days), click **Get Bulk Token** and sign in as an admin of the **destination** tenant.
4. Skip the remaining pages, **Create** the package, and upload the `.ppkg` on the Devices tab.

**If *Get Bulk Token* fails** in Windows Configuration Designer, the usual causes in the
destination tenant are:

- *Require Multifactor Authentication to register or join devices* is on (Entra ID → Devices →
  Device settings), or a Conditional Access policy requires MFA for registering or joining
  devices or for all cloud apps. The token belongs to a `package_<guid>` service account that
  can't do MFA: turn the setting off for the migration window and exclude the package account
  from those policies. Security defaults can also block it.
- *Users may join devices to Microsoft Entra* is not set to **All** (the package account can't
  be in a "Selected" list in advance), or the per-user device limit is too low.
- The sign-in uses a guest account, an account from another tenant, or one without rights to
  create users. Use a Global Administrator of the destination tenant.
- An old Windows Configuration Designer: use the current Store version or the one in the latest
  Windows ADK.

The destination tenant's sign-in logs show the exact error code for the failed sign-in. If you
can't get the token, skip the package and use the manual join.

The package lets any device that runs it join the destination tenant, so treat it like a
password. dolop stores it in R2 and only hands it to devices presenting a valid agent token. The
agent deletes it from the device when it finishes.

## Workflow

1. **Users tab:** add the users first, so devices can be paired with them.
2. **Devices tab → Sync from source tenant.** dolop reads Entra ID, Intune, Autopilot and LAPS,
   pairs each device with its primary user, and suggests a plan per device. Change any plan in
   the table; your choice is kept on later syncs.
3. **Back up all BitLocker keys.** Keys are encrypted at rest; viewing them is logged.
4. Open each device to migrate and work through its **Readiness** list:
   - remove it from Autopilot (otherwise a future reset rejoins the old tenant);
   - make sure a local administrator account works (retrieve the LAPS password if you use it);
   - optionally upload the provisioning package, for an unattended join.
5. **Create agent command.** dolop looks the user up in both tenants and works out both profile
   SIDs. You get three commands (the token in them is shown once):
   - **Check:** run it on the device in *Windows PowerShell (Run as administrator)*. It changes
     nothing and reports its results to the device's page.
   - **Migrate now:** schedules the migration to start in two minutes.
   - **Schedule:** the same, at a date and time you choose (`-At '2026-01-31 18:00'`, device
     local time). If the device is off at that time, it runs as soon as it starts.

   The user must be signed out when the migration starts. Add `-ForceLogoff` to sign them out
   automatically. Tell them to save their work first.
6. Watch progress on the Devices tab. With a package, the device joins and restarts by itself;
   without one, it restarts and shows **awaiting join** until someone joins it in Settings (see
   above). The user then signs in with their **new** account and gets their own desktop.
7. When a device shows **completed**, click **Delete from source tenant** to remove its old
   Intune record and Entra device object. Do the same for devices planned for *Clean up*.

## What the agent does

Run with `-Mode Check`, `-Mode Schedule` or `-Mode Unschedule` from an elevated PowerShell. The
other modes run as SYSTEM from scheduled tasks under `\Dolop\` in Task Scheduler.

**Check** (changes nothing): elevated; Windows edition can join Entra ID; joined to the source
tenant and not to on-premises AD; the command belongs to this device; the source user has a
profile here and the destination user doesn't; the user is signed out; an enabled local admin
account exists; the provisioning package is available; disk space; BitLocker state (the recovery
passwords it finds are sent to dolop as a second backup); Intune enrollment.

**Schedule:** runs Check, saves the agent, its token and the provisioning package (hash-checked)
to `%ProgramData%\Dolop` (readable by SYSTEM and Administrators only), and registers the
*Dolop Device Migration* task.

**Migrate** (as SYSTEM):

1. Signs the user out if `-ForceLogoff` was given, then repeats every check strictly. Any
   failure stops it before anything changes.
2. **Backup:** exports the `ProfileList` registry key and records the user's local group
   memberships under `%ProgramData%\Dolop\backup-<time>`.
3. **Profile hand-over:** moves the profile's `ProfileList` entry to the destination user's SID;
   grants that SID full control of the profile folder and of the user's registry hives;
   exports, then clears, the cached Office and OneDrive sign-ins for the old tenant; and sets
   aside the Windows sign-in token caches (renamed to `*.dolop-old`). If any of this fails, the
   agent restores the backup and stops. The device is unchanged.
4. **Leave the source tenant:** unenrolls from Intune, then `dsregcmd /leave`. If the device
   doesn't leave, the profile is restored and the user can carry on with their old account.
5. **Join the destination tenant** with the provisioning package, and waits up to 10 minutes
   for the join to show. In manual mode it skips this, reports **awaiting join** with the steps
   for whoever joins the device, and schedules the finish task to check every 10 minutes for 3
   days.
6. Registers the *finish* task and restarts the device after one minute.

**PostJoin** (first start-up after the restart, and every 10 minutes while waiting for a manual
join): confirms the device is joined to the destination tenant, backs the BitLocker recovery keys
up to the new tenant, adds the new account to the local groups the old one was in (for example
Administrators), deletes the provisioning package and token from the device, and reports
**completed**. With a package it retries at the next two start-ups if the join hasn't shown up
yet.

Add `-ManualJoin` to the Check or Schedule command to use a manual join even when a package is
uploaded.

### The SIDs

On a device joined to Entra ID, Windows keys a cloud user's profile by a SID derived from their
Entra object id: the 16 GUID bytes in .NET `Guid.ToByteArray()` order, read as four little-endian
32-bit numbers under `S-1-12-1-`. dolop computes it for the source and destination accounts when
it creates the agent command, so the profile can be handed over before the user's first sign-in
with the new account. When the user signs in, Windows finds the profile already keyed by their
SID and loads it.

## When something goes wrong

| What happened | State of the device | What to do |
| --- | --- | --- |
| A check failed | Unchanged | Fix what the check says, run Check again, then schedule |
| Profile hand-over failed | Unchanged (backup restored) | Read the detail on the device's page; fix and retry |
| Couldn't leave the source tenant | Still in the source tenant, profile restored | Retry, or disconnect it in *Settings → Accounts → Access work or school* |
| Left the source tenant, but the join failed | Not joined to any tenant; profile already handed over | Sign in with the local admin, check the package (bulk token expiry), then either run *Migrate now* again (it resumes at the join) or join in *Settings → Accounts → Access work or school* with the user's new account |
| Awaiting join for 3 days (manual join) | Not joined to any tenant; profile already handed over | Join it in *Settings → Accounts → Access work or school*, then *Mark done* in dolop (the finish step no longer runs: back the BitLocker key up to the new tenant by hand) |
| Joined, but the finish step failed | In the destination tenant | Check the detail; back up BitLocker keys and local groups by hand if needed; *Mark done* |

To undo the profile hand-over by hand (only meaningful while the device is still in the source
tenant), run the agent with `-Mode RestoreProfile` from an elevated PowerShell. The agent log is
at `%ProgramData%\Dolop\agent.log`.

## Afterwards: what the user notices

- They sign in with their new account. Their desktop, files and apps are as they were.
- **Windows Hello** (PIN, face, fingerprint) is set up again for the new account.
- **OneDrive** asks them to sign in. Sign in with the new account and let it sync to a **new**
  folder. dolop has already copied their files to the new OneDrive, and the old *OneDrive - Old
  Org* folder stays on disk until you remove it.
- **Office apps** ask them to sign in with the new account.
- **Outlook:** create a new Outlook profile for the new mailbox (or let the new Outlook add the
  account). The old profile still points at the old mailbox.
- Apps that store their own sign-ins (VPN clients, line-of-business apps) may need signing into
  again.

## Security

- Each agent command carries its own random 256-bit token. dolop stores only its SHA-256, it
  expires (14 days by default), it can be revoked from the device's page, and it is invalidated
  when the device completes. It only lets the device read its own plan, download the
  provisioning package and post reports.
- The agent script itself contains no secrets and is served publicly at `/api/agent/script`.
  On the device, the token and package live in `%ProgramData%\Dolop`, readable only by SYSTEM
  and Administrators, and are deleted at the end.
- BitLocker recovery keys are AES-256-GCM encrypted in D1 under `ENCRYPTION_KEY`; viewing them
  writes a warning-level entry to the activity log.
