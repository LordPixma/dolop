# BitTitan User Migration Bundle — parity matrix

How dolop compares to the MigrationWiz User Migration Bundle for tenant-to-tenant (T2T)
M365 moves, and where the honest gaps are.

## Parity

| BitTitan capability | dolop |
| --- | --- |
| Mailbox migration (mail, folders, attachments) | ✅ full hierarchy, read state/timestamps via MAPI extended properties, large attachments via upload sessions |
| Calendar migration | ✅ all calendars, singles + recurring series (see caveats) |
| Contacts migration | ✅ default + named folders |
| Tasks migration | ✅ Microsoft To Do lists/tasks/checklists (app-only API support varies by tenant; surfaced as a clear item error) |
| Document (OneDrive) migration | ✅ delta-based, any file size, timestamps preserved |
| Pre-stage + full + delta passes | ✅ pass types with date filtering; per-folder/drive delta tokens; id-map dedupe |
| Concurrent migration management | ✅ per-project concurrency gate (coordinator DO) |
| Throttling management | ✅ honors `Retry-After`, jittered backoff, automatic resume |
| Item-level error reporting / retry | ✅ per-item error log; next delta pass retries failures |
| User provisioning + licensing | ✅ bulk create with one-time passwords, SKU assignment |
| Assessment / sizing | ✅ mailbox item counts, OneDrive bytes, destination readiness checks |
| Reporting | ✅ CSV user + error reports, archived to R2 |
| Inbox rules, auto-replies, mailbox settings, categories | ✅ (BitTitan needs the DMA agent for some of this; dolop does it server-side via Graph) |

## Caveats and gaps (read before promising users anything)

| Area | Status | Notes / workaround |
| --- | --- | --- |
| **DeploymentPro (Outlook profile reconfiguration)** | ❌ out of scope | No cloud API can rewrite local Outlook profiles. Use Intune/Autopilot, GPO, or documented manual steps post-cutover. |
| **In-place (online) archive mailboxes** | ❌ | Microsoft Graph cannot reach online archives (EWS-only). Expand/export archives separately if needed. |
| Recurring event **exceptions** (modified single occurrences) | ⚠️ | Series masters migrate with full recurrence; individually-modified occurrences are not recreated. |
| Event **organizer** | ⚠️ | Graph sets the organizer to the destination mailbox owner; original organizer/attendees preserved in the `com.dolop.migration` open extension. Attendees stripped by default to avoid invitation storms (configurable). |
| **Item attachments** (emails attached to emails) | ⚠️ | Copied without full fidelity; each is logged as an item error for review. |
| Mailbox **permissions/delegates**, shared-mailbox ACLs | ❌ | Re-grant in the destination (Exchange admin / PowerShell). Shared mailboxes themselves migrate fine — add them as users in scope. |
| Distribution lists, M365 Groups, Teams | ❌ | Outside the *user* bundle scope; use directory tooling. |
| Contact photos, S/MIME certificates | ❌ | Not migrated. |
| Domain move (UPN/SMTP domain transfer between tenants) | ➖ | Inherently a Microsoft-side DNS/Entra operation in any tool; see the runbook cutover section. |

## Operating notes

- Graph application access means **no per-user credentials** are ever collected. Tenant
  onboarding matches BitTitan's model: send the tenant's Global Admin a consent link and the
  connector binds itself (or register a per-tenant app manually if the org requires it);
  consent can be revoked any time by deleting the enterprise application.
- Mailbox throughput is bounded by Microsoft Graph mailbox-level throttling, the same wall
  every Graph-based tool hits; pre-stage early and rely on delta passes rather than expecting
  cutover-day bulk speed.
