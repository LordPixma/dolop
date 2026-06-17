# Dolop

**Open-source Microsoft 365 tenant-to-tenant migration, built entirely on Cloudflare.**

[![deploy](https://github.com/LordPixma/dolop/actions/workflows/deploy.yml/badge.svg)](https://github.com/LordPixma/dolop/actions/workflows/deploy.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020)](https://workers.cloudflare.com/)

Dolop migrates user accounts between Microsoft 365 tenants — the job commercial tools charge per-user licences for — using nothing but the Cloudflare developer platform and the Microsoft Graph API. No servers, no VMs, no agents: the entire
migration engine runs in Workers and Durable Objects, and you self-host it on your own
Cloudflare account for pennies.

Built for **M&A scenarios**: assess, provision, pre-stage weeks ahead, keep tenants in sync
with delta passes, then cut over with minimal user disruption.

> **Status: beta.** Dolop is young and moving fast. Always run an assessment pass first,
> pilot with test users, and treat the [parity & limitations doc](docs/bittitan-parity.md)
> as required reading before promising anyone a migration date.

## What it migrates

| Workload | Detail |
| --- | --- |
| **Mail** | Full folder hierarchy (well-known folders mapped), messages with read state, timestamps, categories, flags and importance preserved via MAPI extended properties; attachments (large ones via resumable upload sessions); per-folder Graph **delta tokens** make every later pass incremental |
| **Calendar** | All calendars, single events and recurring series; attendees stripped by default so the destination never blasts meeting invites (original attendee list preserved in an open extension) |
| **Contacts** | Default + named contact folders, full field fidelity |
| **Tasks** | Microsoft To Do lists, tasks, checklist items, recurrence |
| **OneDrive** | Full drive via delta enumeration, folder structure, timestamps; files of any size streamed in 10 MiB chunks (never buffered whole); changed files re-copied on delta passes via cTag comparison |
| **Rules & settings** | Inbox rules (folder ids remapped), Outlook master categories, mailbox settings (auto-reply, time zone, working hours, locale) |
| **Coexistence** | Mail dual-delivery: a managed forwarding rule keeps both mailboxes fed so mail to one address is received in both tenants — one direction at a time (no loops), flipped at cutover, off when you retire the other tenant |
| **Provisioning** | Create destination accounts in bulk with one-time passwords and license assignment (SKU picker) |
| **Assessment** | Pre-migration sizing (mailbox item counts, OneDrive usage) and destination readiness checks — writes nothing |
| **Tenant onboarding** | BitTitan-style **admin consent links**: one multi-tenant app, a Global Admin clicks approve, the connector binds itself — or manual per-tenant app registrations if preferred |

### The migration model

- **Assessment → Provision → Pre-stage → Delta → Cutover → Final delta**
- Pass types: **pre-stage** (mail older than a cutoff), **full** (everything, idempotent),
  **delta** (only changes since the last pass), **assessment** (read-only sizing)
- **Auto-delta**: cron-scheduled sync keeps tenants converged until cutover day
- **Coexistence**: optional mail dual-delivery so both mailboxes receive live mail during the
  overlap window — flip its direction at cutover, switch it off when the other tenant retires
- **Live dashboard**: real progress denominators (mailbox folder counts, OneDrive quota),
  per-workload bars, per-mailbox activity, items/min and data/min throughput
- **Item-level error reporting**: failures never stop a mailbox; they're logged per item and
  retried on the next delta pass. CSV user/error reports archive to R2.
- **Concurrency control** per project, automatic Graph throttling backoff, resumable from
  any interruption (state lives in Durable Object SQLite)

## Architecture — 100% Cloudflare

```
                       ┌────────────────────────────────────────────────┐
 Browser dashboard ───►│  Worker (Hono API + static assets)             │
                       │   /api/* → D1, Queues, DO stubs                │
                       └───────┬───────────────────┬────────────────────┘
                               │                   │
                  ┌────────────▼────┐      ┌───────▼─────────────────────┐
                  │ Queue           │      │ ProjectCoordinator (DO)     │
                  │ dolop-migrations│─────►│ concurrency gate + queue    │
                  └─────────────────┘      └───────┬─────────────────────┘
                                                   │ admits up to N users
                                   ┌───────────────▼──────────────────────┐
                                   │ MigrationOrchestrator (DO, per user) │
                                   │ alarm-driven tick loop               │
                                   │ SQLite: cursors, id map, work queue  │
                                   │ Graph src ──items──► Graph dest      │
                                   └───────┬──────────────────────────────┘
                                           │ stats / item errors / events
        KV (Graph token cache)             ▼
        R2 (report archive)            D1 (projects, connectors,
        Cron (auto-delta + watchdog)       users, stats, errors, audit)
```

Deep dive: [docs/architecture.md](docs/architecture.md)

## Quickstart

Prerequisites: a Cloudflare account on the **Workers Paid** plan (Queues requires it; from
$5/month) and admin access to both M365 tenants.

```sh
git clone https://github.com/LordPixma/dolop.git && cd dolop
npm install

# 1. Provision Cloudflare resources (then put the two printed ids in wrangler.jsonc)
wrangler d1 create dolop
wrangler kv namespace create KV
wrangler r2 bucket create dolop-artifacts
wrangler queues create dolop-migrations
wrangler queues create dolop-dlq

# 2. Secrets
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY   # set ONCE — never change casually
openssl rand -hex 32    | wrangler secret put API_TOKEN        # automation + password recovery

# 3. Schema + deploy
npm run db:migrate
npm run deploy
```

Open the deployed URL — the first visit walks you through creating the initial
**administrator account** (username/password; PBKDF2-hashed, HttpOnly session cookies, login
rate-limiting). Then connect your tenants — with **admin consent links** (recommended; see
Option A in [docs/setup.md](docs/setup.md)) or manual per-tenant app registrations — create
a project, and follow the [M&A runbook](docs/runbook.md).

**CI deploys:** [.github/workflows/deploy.yml](.github/workflows/deploy.yml) auto-deploys on
push to `main` once you add a `CLOUDFLARE_API_TOKEN` repository secret (it also applies D1
migrations, ensures queues exist, and syncs optional `DOLOP_*` secrets).

> Forking? Replace the `database_id` and KV `id` in `wrangler.jsonc` with your own resource
> ids — they identify the original deployment's resources and won't resolve on your account.

## Documentation

| Doc | What's in it |
| --- | --- |
| [Setup guide](docs/setup.md) | Entra app registrations (consent-link & manual modes), permissions, Cloudflare provisioning |
| [M&A runbook](docs/runbook.md) | Step-by-step cutover playbook, from assessment to aftercare |
| [Coexistence](docs/coexistence.md) | Mail dual-delivery during the overlap window: how forwarding works, direction at cutover, the external-forwarding caveat |
| [Architecture](docs/architecture.md) | Engine internals, tick budgets, idempotency model, security |
| [FAQ](docs/faq.md) | Costs, speed, data handling, comparisons, troubleshooting |
| [Parity & limitations](docs/bittitan-parity.md) | Honest feature matrix vs commercial tools — read before cutover |

## Security

Tenant secrets are AES-256-GCM encrypted at rest with a key that exists only as a Worker
secret; Graph access is app-only (no user credentials ever collected); operator passwords
are PBKDF2-hashed; sessions are HttpOnly cookies storing only a hash server-side. Hardening
guidance (Cloudflare Access, Exchange application access policies) is in
[SECURITY.md](SECURITY.md) — which is also where to report vulnerabilities.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup
(`npm run typecheck`, `npm test`, `npm run dev`) and project layout.

## License & disclaimer

[MIT](LICENSE). Dolop is an independent open-source project: not affiliated with, endorsed
by, or supported by Microsoft or BitTitan. Microsoft 365 is a trademark of Microsoft
Corporation; MigrationWiz is a trademark of BitTitan, Inc. — referenced only for feature
comparison. Migrations move real people's mailboxes: test thoroughly, read the limitations,
and use at your own risk.
