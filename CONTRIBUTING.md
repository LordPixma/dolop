# Contributing to dolop

Thanks for your interest! Issues, docs fixes and PRs are all welcome.

## Development setup

```sh
git clone https://github.com/LordPixma/dolop.git && cd dolop
npm install
npm run typecheck     # strict TypeScript across src + tests
npm test              # vitest unit tests
```

For a local dev server (`npm run dev`), create `.dev.vars`:

```
ENCRYPTION_KEY=<openssl rand -base64 32>
API_TOKEN=dev-token
```

`wrangler dev` runs D1/KV/R2/Queues/Durable Objects locally — no Cloudflare resources
needed until you deploy. Exercising the migration engines end-to-end requires two M365
tenants (Microsoft 365 Developer Program tenants work well).

## Project layout

```
src/index.ts          Worker entry: routing, queue consumer, cron
src/api/              REST endpoints (auth, connectors, projects, users, migrations, reports)
src/do/               Durable Objects: per-user orchestrator, per-project coordinator
src/engine/           Workload engines (mail, calendar, contacts, tasks, drive, rules,
                      assessment) + shared store/budget/transform/upload helpers
src/graph/            Microsoft Graph client (app-only auth, throttling) and types
src/accounts.ts       Operator accounts, password hashing, sessions
src/crypto.ts         AES-GCM secret encryption, HMAC-signed consent state
migrations/           D1 schema migrations
public/               Dependency-free dashboard SPA
test/                 Vitest unit tests for pure logic
docs/                 Setup, runbook, architecture, FAQ, parity
```

## Pull requests

- Keep `npm run typecheck` and `npm test` green; add tests for pure logic
  (transforms, utils, crypto) where practical.
- Match the existing style: small modules, explanatory comments where behaviour is
  non-obvious (especially anything touching Graph semantics or migration fidelity).
- Migration fidelity changes (what gets copied, how) should update
  [docs/bittitan-parity.md](docs/bittitan-parity.md) in the same PR.
- New D1 schema = new file in `migrations/` — never edit an applied migration.
- One logical change per PR, with a description of *why*.

## Good first areas

- Additional workload fidelity (contact photos, recurring-event exceptions, item attachments)
- A read-only `auditor` role (the accounts schema already carries `role`)
- Localization of the dashboard
- More unit tests around engine cursor/resume logic

## Conduct

Be kind and constructive. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
