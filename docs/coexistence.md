# Mail coexistence (dual-delivery)

During an M&A migration there is usually a window — often weeks — where both tenants are
live and you cannot yet retire the source. People are still being told "we're moving you to
the new system", mail keeps arriving at the old addresses, and nobody wants a message to land
in a mailbox the user has stopped checking.

Dolop's **coexistence** feature keeps both mailboxes fed: a copy of every incoming message is
delivered to the user's mailbox in *both* tenants, so mail sent to one address is received in
both. You turn it on when pre-staging, flip its direction at cutover, and turn it off only
when the organisation is confident the other tenant can be switched off.

## How it works

Dolop is app-only Microsoft Graph end to end — no Exchange PowerShell, no agents. Coexistence
is therefore built on the one dual-delivery mechanism Graph exposes: a **managed inbox rule**.

For each in-scope mailbox Dolop creates and owns a single rule named
**`Dolop Coexistence (do not delete)`** whose action is `forwardTo` the user's counterpart
address in the other tenant. `forwardTo` *keeps the original in the mailbox and sends a copy
onward*, which is exactly "received in both tenants". Enabling, switching, and disabling just
find-or-create / delete that one rule — Dolop never touches the user's own rules, and the
rules-migration workload deliberately skips this rule so it is never copied across tenants.

### One direction at a time (no loops)

Two mailboxes forwarding to each other is a mail loop. Dolop avoids this structurally:
coexistence runs in exactly **one direction per user at any time**, matching where inbound
mail (your MX record) currently lands.

| Phase | MX points to | Direction | What happens |
| --- | --- | --- | --- |
| Pre-stage / pre-cutover | Source | **Source → Destination** | The source mailbox forwards a copy to the destination, keeping the new mailbox warm. The destination receives no external mail directly, so there is no loop. |
| After cutover | Destination | **Destination → Source** | The destination mailbox forwards a copy back to the source for anyone still working there. Switching tears down the source-side rule first. |
| Retirement | Destination | *(off)* | The managed rule is removed everywhere. |

Because only one side ever holds a rule, a loop cannot form. Exchange Online's own
forwarding-loop suppression is a backstop, not the primary guard.

### Where it forwards to

By default Dolop forwards to the counterpart's **`onmicrosoft.com` routing address** (for
example `ada@target.onmicrosoft.com`), resolved automatically from the mailbox's proxy
addresses. This matters: **before a domain cutover the vanity domain (`ada@new.com`) is not
yet verified in the target tenant**, so forwarding to it would bounce — but the
`onmicrosoft.com` routing address always exists and always routes. You can switch the "Forward
to" option to the mapped UPN if you prefer, and the per-user forward address is recorded so
you can see exactly where each mailbox is forwarding.

## Using it

In a project, open the **Coexistence** tab.

1. Choose the **direction** (Source → Destination before cutover) and the **Forward to**
   address mode (onmicrosoft routing address is recommended).
2. **Enable selected** or **Enable all**. Dolop creates the forwarding rule on the chosen side
   for each user and shows per-user status (active / failed) and the address each one forwards
   to.
3. At **cutover**, change the direction to Destination → Source and click **Enable all**
   again. Dolop removes the old rule and builds the reverse one in a single step.
4. When you're ready to retire the other tenant, **Disable all** — every managed rule is
   removed.

Via the API:

```sh
# Enable source→dest dual-delivery for two users, forwarding to routing addresses
curl -X POST .../api/projects/$PRJ/coexistence/enable \
  -H 'content-type: application/json' \
  -d '{"userIds":["usr_a","usr_b"],"direction":"src_to_dest","forwardMode":"routing"}'

# Flip direction at cutover (same endpoint — it tears down the old rule first)
curl -X POST .../api/projects/$PRJ/coexistence/enable \
  -d '{"userIds":["usr_a","usr_b"],"direction":"dest_to_src"}'

# Turn it off
curl -X POST .../api/projects/$PRJ/coexistence/disable -d '{"userIds":["usr_a","usr_b"]}'

# Rollup
curl .../api/projects/$PRJ/coexistence
```

Omitting `userIds` targets the whole project (capped per request — the dashboard batches large
scopes automatically).

## Permissions

Coexistence needs only the permissions Dolop already uses — `MailboxSettings.ReadWrite` (to
manage inbox rules) on the forwarding side and `User.Read.All` (to resolve the counterpart's
routing address) on the receiving side. No extra app permissions are required.

## Important caveats

- **External auto-forwarding may be blocked.** Forwarding to a *different tenant* — including
  its `onmicrosoft.com` address — is **external** auto-forwarding, which Microsoft's default
  outbound anti-spam policy blocks (`AutoForwardingMode: Automatic`). If you enable
  coexistence and copies don't arrive, set the outbound spam filter policy on the **forwarding
  tenant** to allow automatic forwarding (`Set-HostedOutboundSpamFilterPolicy -AutoForwardingMode On`),
  or scope an allow-policy to the in-scope users. This is the most common reason mail doesn't
  show up in both places.
- **Forwarded-copy fidelity.** The copy is delivered as an inbox-rule forward (it appears as
  forwarded by the user), not a transparent SMTP redirect. Mailbox-level dual-delivery
  (`Set-Mailbox -DeliverToMailboxAndForward`) would be cleaner but is not available through
  Microsoft Graph — it is an Exchange PowerShell operation outside Dolop's app-only model.
- **Mail only.** This feature is mail dual-delivery. Calendar free/busy sharing and
  directory/GAL coexistence require cross-tenant organisation relationships and are **not**
  achievable app-only via Graph — see [bittitan-parity.md](bittitan-parity.md).
- **The destination mailbox must exist.** Provision (and license) destination users before
  enabling Source → Destination coexistence, or the forward target won't resolve.
