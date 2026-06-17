# Changelog

## Unreleased

- **Mail coexistence (dual-delivery)**: optionally keep both tenants' mailboxes fed during the
  migration overlap window. Dolop manages a single forwarding inbox rule per mailbox that
  forwards a copy of incoming mail to the user's counterpart in the other tenant, so mail to
  one address is received in both. One direction is active per user at a time (no loops),
  flipped at cutover and switched off when the other tenant is retired. New Coexistence tab,
  `/api/projects/:id/coexistence[/enable|/disable]` endpoints, and [docs/coexistence.md](docs/coexistence.md).
- Coexistence visibility: per-user coexistence status now shows as a column on the Users tab
  and is included in the user CSV report (status, direction, forward address).

## 0.1.0 — 2026-06-10

First public release.

- Migration engines: mail (folder hierarchy, MAPI fidelity, attachments, delta sync),
  calendar (invite-safe attendee handling), contacts, To Do tasks, OneDrive (chunked
  resumable uploads, cTag delta re-copy), inbox rules / categories / mailbox settings
- Pass model: assessment, pre-stage, full, delta — idempotent via per-user id maps and
  persisted Graph delta tokens; cron-driven auto-delta
- Tenant onboarding: admin-consent links (multi-tenant app) or manual per-tenant app
  registrations; AES-256-GCM-encrypted secrets
- Bulk provisioning with one-time passwords and license assignment; user discovery,
  auto-mapping, CSV import, post-discovery destination remapping with state reset
- Live progress dashboard: real denominators (folder counts, drive quota), per-workload
  bars, per-mailbox activity, throughput; CSV user/error reports archived to R2
- Operator accounts (PBKDF2, sessions, rate limiting) with first-run setup and team
  management; API token retained for automation and recovery
- Runs entirely on Cloudflare: Workers, Durable Objects (SQLite), D1, Queues, KV, R2,
  cron triggers; GitHub Actions auto-deploy
