# Architecture

Dolop runs entirely on the Cloudflare developer platform. There is exactly one deployable
unit — a Worker — plus the data services it binds to.

## Components

| Piece | Cloudflare service | Role |
| --- | --- | --- |
| API + dashboard | Worker (Hono) + static assets | REST API under `/api/*`; SPA for everything else (`run_worker_first` keeps assets off the Worker path) |
| Control DB | D1 | projects, connectors (secrets AES-256-GCM encrypted), user mappings, per-user stats, item-level errors, audit events |
| Migration engine | Durable Objects (SQLite) | `MigrationOrchestrator` — one per (project, user); `ProjectCoordinator` — one per project |
| Fan-out | Queues (`dolop-migrations`) | start requests flow API → queue → coordinator, with retries + DLQ |
| Token cache | KV | app-only Graph tokens per tenant/app, TTL'd to expiry−5 min |
| Artifacts | R2 | CSV report archive |
| Scheduling | Cron trigger (15 min) | auto-delta passes; watchdog that re-arms stalled orchestrators |

## The orchestrator tick loop

A migration pass is a chain of Durable Object **alarms**. Each tick:

1. Reload job state from DO SQLite (`sys:job`), honor stop requests.
2. Decrypt connector secrets (master key only ever lives in the `ENCRYPTION_KEY` secret),
   build throttle-aware Graph clients (tokens from KV).
3. Run the current workload engine's `step()` under a **TickBudget**
   (≤80 Graph subrequests, ≤25 items, ≤20 s wall) — comfortably inside Worker limits.
4. Flush stats + buffered item errors to D1 (this also writes the heartbeat).
5. Re-arm the alarm: +250 ms on progress, `Retry-After` (+ jitter) on Graph 429/503,
   exponential backoff on transient failures (fatal after 5 consecutive), nothing when done.

Because every cursor lives in DO SQLite, an eviction, redeploy, or crash at any point costs
at most one tick of repeated work.

### Engine state model (per-user DO SQLite)

- `kv` — `phase:*` and `state:*` keys (reset every pass) plus `cursor:*` keys
  (**persist across passes**: mail per-folder delta links keyed by filter signature,
  the OneDrive delta token).
- `idmap` — source id → destination id per workload. This is the idempotency backbone:
  pre-stage → full → delta sequences never duplicate an item.
- `work` — durable work queue (folder scans, pending file copies), drained across ticks.

### Workload specifics

- **Mail**: well-known folders probed on both sides and mapped name-to-name; the rest of the
  tree is find-or-created. Messages import with `PR_MESSAGE_FLAGS`/delivery/submit-time MAPI
  properties so they arrive as read/unread *received* mail, not drafts. Attachments >3 MB go
  through destination upload sessions; an interrupted attachment copy resumes exactly
  (the `att` state survives throttle pauses).
- **Drive**: single delta walk queues file work; uploads >4 MB use Graph upload sessions fed
  by ranged reads of the source `@microsoft.graph.downloadUrl` — 10 MiB (32×320 KiB) chunks,
  so a 50 GB PST-dump file streams through a Worker without ever being in memory at once.
  Expired download URLs are refreshed transparently. cTag changes trigger re-copy on delta.
- **Calendar**: attendees stripped by default (no invitation storms); originals are stored in
  a `com.dolop.migration` open extension on the destination event.
- **Rules**: run after mail so `moveToFolder` actions can be remapped via the folder id map.

## Concurrency & flow control

`POST /api/projects/:id/start` marks users *queued* and drops batches on the queue. The
queue consumer hands them to the project's `ProjectCoordinator`, which admits users to their
orchestrators up to `maxConcurrentUsers`; every terminal pass status reports back to the
coordinator, which admits the next user. The cron watchdog covers the gap webhooks can't:
any user still *running* with a heartbeat older than 10 minutes gets its orchestrator poked
(`/resume`), which either re-arms the alarm or releases the coordinator slot.

## Security

- Tenant client secrets: AES-256-GCM (random IV per encryption) under a key that exists only
  as a Worker secret; never returned by any API.
- API: constant-time bearer-token check on every `/api` route; Cloudflare Access recommended
  in front for IdP-backed access control.
- Graph access is app-only; consider Exchange application access policies to scope the app
  to in-scope mailboxes (see setup guide).
