# dolop

**Microsoft 365 tenant-to-tenant migration, built entirely on Cloudflare.**

Dolop migrates user accounts between M365 tenants during M&A activity — the same job as
BitTitan MigrationWiz **User Migration Bundle** licences — using nothing but the Cloudflare
developer platform and the Microsoft Graph API. No servers, no VMs, no agents to babysit:
the entire migration engine runs in Workers and Durable Objects.

## What it migrates

| Workload | Detail |
| --- | --- |
| **Mail** | Full folder hierarchy (well-known folders mapped), messages with read state, timestamps, categories, flags and importance preserved via MAPI extended properties; attachments (large ones via resumable upload sessions); per-folder Graph **delta tokens** make every later pass incremental |
| **Calendar** | All calendars, single events and recurring series; attendees stripped by default so the destination never blasts meeting invites (original attendee list preserved in an open extension) |
| **Contacts** | Default + named contact folders, full field fidelity |
| **Tasks** | Microsoft To Do lists, tasks, checklist items, recurrence |
| **OneDrive** | Full drive via delta enumeration, folder structure, timestamps; files of any size streamed in 10 MiB chunks (never buffered whole); changed files re-copied on delta passes via cTag comparison |
| **Rules & settings** | Inbox rules (folder ids remapped), Outlook master categories, mailbox settings (auto-reply, time zone, working hours, locale) |
| **Provisioning** | Create destination accounts in bulk with one-time passwords and license assignment (SKU picker) |
| **Assessment** | Pre-migration sizing (mailbox item counts, OneDrive usage) and destination readiness checks — writes nothing |
| **Tenant onboarding** | BitTitan-style **admin consent links**: one multi-tenant app, a Global Admin clicks approve, the connector binds itself — or manual per-tenant app registrations if preferred |

### Migration model (BitTitan-style)

- **Assessment → Provision → Pre-stage → Delta → Cutover → Final delta**
- **Pre-stage pass**: bulk-copy mail older than a cutoff date ahead of cutover
- **Full pass**: everything, idempotent — already-migrated items are skipped via a per-user id map
- **Delta pass**: only changes since the last pass (Graph delta tokens persisted per folder/drive)
- **Auto-delta**: cron-scheduled delta sync keeps tenants converged until cutover day
- **Concurrency control**: per-project concurrent-user limit, queue managed by a coordinator
- **Item-level error reporting**: failures never stop a mailbox; they're logged per item and
  retried on the next delta pass. CSV user/error reports archive to R2.

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

Every user gets a **Durable Object orchestrator** whose SQLite storage holds delta cursors,
the source→destination id map and a resumable work queue. Work happens in bounded alarm
"ticks"; Graph throttling (429) pauses exactly as long as `Retry-After` demands, transient
errors retry with backoff, and the cron watchdog re-arms any stalled orchestrator. The DO
can be evicted or redeployed mid-mailbox and the next tick picks up where it left off.

## Quickstart

```sh
npm install

# 1. Provision Cloudflare resources
wrangler d1 create dolop                  # paste database_id into wrangler.jsonc
wrangler kv namespace create KV           # paste id into wrangler.jsonc
wrangler r2 bucket create dolop-artifacts
wrangler queues create dolop-migrations
wrangler queues create dolop-dlq

# 2. Secrets
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY   # encrypts tenant secrets (AES-256-GCM)
openssl rand -hex 32    | wrangler secret put API_TOKEN        # dashboard/API bearer token

# 3. Schema + deploy
npm run db:migrate
npm run deploy
```

Then connect your tenants — either with **admin consent links** (one multi-tenant app,
recommended; see Option A in [docs/setup.md](docs/setup.md)) or manual per-tenant app
registrations (Option B) — open the deployed URL, paste your API token, create a project,
and follow the [M&A runbook](docs/runbook.md).

**CI deploys:** `.github/workflows/deploy.yml` auto-deploys on push once you add a
`CLOUDFLARE_API_TOKEN` repository secret (it also applies D1 migrations, ensures queues
exist, and syncs optional `DOLOP_*` secrets).

> **Production hardening:** put the Worker behind
> [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) so the
> dashboard and API require your IdP login at the edge in addition to the API token.

## Docs

- [docs/setup.md](docs/setup.md) — Entra app registrations, permissions, Cloudflare provisioning
- [docs/runbook.md](docs/runbook.md) — step-by-step M&A cutover playbook
- [docs/architecture.md](docs/architecture.md) — engine internals, budgets, idempotency model
- [docs/bittitan-parity.md](docs/bittitan-parity.md) — feature parity matrix and honest limitations

## Development

```sh
npm run typecheck   # strict TS across src + tests
npm test            # vitest unit tests (crypto, transforms, utils)
npm run dev         # wrangler dev (put ENCRYPTION_KEY/API_TOKEN in .dev.vars)
```
