# Frequently asked questions

## General

### What is dolop, in one sentence?
A self-hosted, open-source alternative to per-user-licensed M365 tenant-to-tenant migration
tools (BitTitan MigrationWiz, ShareGate, Quest ODM), running entirely on your own Cloudflare
account.

### Why Cloudflare instead of a server or container?
Migrations are long-running, bursty, interruption-prone jobs. Durable Objects give every
mailbox its own persistent, single-threaded state machine (cursors, id maps, work queues in
SQLite) that survives restarts and redeploys; Queues, KV, D1, R2 and cron triggers cover
everything else. There is no machine to patch, scale, or keep awake for a three-week
pre-stage.

### Is this affiliated with Microsoft or BitTitan?
No. Independent open-source project, MIT-licensed. Trademarks are referenced only for
comparison.

## Cost & performance

### What does it cost to run?
- **Cloudflare**: the Workers Paid plan ($5/month minimum) is required (Queues). Actual
  usage — Worker requests, DO duration, D1/KV/R2 operations — typically adds single-digit
  dollars even for thousands of mailboxes, because the heavy lifting is I/O wait on Graph.
- **Microsoft**: the Graph API is free. Destination licenses are your normal M365 spend.
- **dolop**: free, MIT.

### How fast does it migrate?
The bottleneck is Microsoft Graph's *per-mailbox* throttling, which every Graph-based tool
shares — expect rough order of 1–4 GB/day per mailbox for mail, much faster for OneDrive
files. The answer to "will it be done by Monday?" is the M&A pattern, not raw speed:
**pre-stage weeks early, run delta passes, cut over with only days of changes left.**
Project concurrency (Settings) controls how many mailboxes run in parallel; per-mailbox
throttling means raising it increases aggregate throughput, not per-user speed.

### Why does the progress bar say 90% for a workload?
Workloads with no knowable upfront total (calendar, contacts, tasks) cap at 90% until they
actually finish. Mail and OneDrive use real denominators (folder item counts, drive quota).

## Data & security

### Does dolop store my mailbox data?
No. Items stream from source tenant to destination tenant through the Worker per-request;
nothing is persisted except metadata: migration stats, item-level *error descriptions*
(subject lines may appear there), the source→destination id map, and CSV reports you
generate (R2). Tenant app secrets are AES-256-GCM encrypted in D1 with a key held only as a
Worker secret.

### What credentials does it need?
App-only (client credentials) Graph access to each tenant — never user passwords. Use the
admin-consent link flow (one multi-tenant app, approve once) or per-tenant app
registrations. Either way the tenant can revoke access at any time by deleting the
enterprise application. See [setup.md](setup.md), including how to scope mailbox access
with Exchange application access policies.

### Who can open the dashboard?
Operator accounts (username/password, PBKDF2-hashed, rate-limited, server-side sessions).
The `API_TOKEN` secret authenticates automation and doubles as the password-recovery path.
For production, additionally put the Worker behind Cloudflare Access.

## Migration behaviour

### What happens if a migration is interrupted (redeploy, crash, throttling)?
Nothing is lost. Every cursor lives in the per-user Durable Object's SQLite storage; the
next alarm tick resumes where the last one stopped. Graph 429s pause exactly as long as
`Retry-After` demands. A cron watchdog re-arms anything stalled.

### Can I re-run a migration? Will it duplicate items?
Re-runs are idempotent: a per-user id map records every item already copied, and mail/drive
use Graph delta tokens, so later passes only touch new or changed items.

### Why do migrated calendar events have no attendees?
Default safety: creating events with attendees can make Exchange Online send meeting
invitations to every attendee — a thousand-user migration would be a spam storm. The
original attendee list and organizer are preserved on each event in a
`com.dolop.migration` open extension, and you can opt into preserving live attendees per
pass.

### Can it migrate shared mailboxes?
Yes — add them as users in scope (they resolve like any mailbox via Graph). Note mailbox
*permissions/delegates* are not migrated; re-grant those in the destination.

### What can't it migrate?
Read [bittitan-parity.md](bittitan-parity.md). Headlines: Outlook profile reconfiguration
(use Intune/GPO), in-place archive mailboxes (Graph can't reach them), recurring-event
exceptions, mailbox permissions, Teams/SharePoint/Groups (outside user-migration scope).

### I changed a user's destination mapping — what happens to already-migrated items?
Remapping wipes that user's migration state (id map + delta cursors) so the next pass fully
re-copies to the new mailbox. Items already copied to the old mailbox are left untouched.

## Operations

### Can one deployment handle several migrations at once?
Yes. Connectors are reusable; projects are independent, each with its own user scope,
settings and concurrency. Run as many projects in parallel as you like.

### Why did discovery suddenly fail with a decryption error?
The `ENCRYPTION_KEY` Worker secret changed after connectors were saved (commonly: a CI
deploy synced a different `DOLOP_ENCRYPTION_KEY` GitHub secret). Fix: *Connectors → Rotate
secret*, re-enter the client secret, Verify. Prevention: set the key once, before creating
connectors, and never change it.

### A user shows `completed_with_errors` — now what?
Open the user → review item errors (also on the project Errors tab / CSV report). Fix root
causes where applicable, then run a **delta** pass — failed items are retried, succeeded
items are skipped.

### To Do tasks fail with `access_denied`?
Some tenants reject app-only access to the To Do API even with `Tasks.ReadWrite.All`
granted. Dolop logs it clearly and continues with other workloads.

### How do I get help / report a bug?
Open a [GitHub issue](https://github.com/LordPixma/dolop/issues). For security
vulnerabilities, see [SECURITY.md](../SECURITY.md) — please report privately.
