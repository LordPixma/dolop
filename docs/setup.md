# Setup guide

Dolop talks to both tenants app-only (client credentials). There are two ways to connect a
tenant; the Cloudflare side is the same either way (a single Worker plus D1/KV/R2/Queues).

| | Option A — admin consent link (recommended) | Option B — manual per-tenant apps |
| --- | --- | --- |
| Setup in each tenant | A Global Admin clicks one link | Register an app, add 10 permissions, consent, copy 3 values |
| App registrations needed | **One**, in your home tenant, once | One per tenant |
| Secrets handled | None per tenant (one Worker secret) | One client secret per tenant (AES-encrypted in D1) |
| Best for | M&A counterparties, repeat use, MSPs | Orgs that mandate their own app registration |

## Option A — one multi-tenant app + admin consent links

This is how BitTitan/ShareGate onboard tenants: Dolop owns **one** multi-tenant app; a
target tenant's Global Administrator approves a consent link and the tenant connects itself
— no registration or secret on their side.

One-time setup in **your home tenant** (any tenant you control — it does not have to be the
source or destination):

1. **App registrations → New registration**
   - Name: `dolop`
   - Supported account types: **Accounts in any organizational directory (multitenant)**
   - Redirect URI: *Web* → `https://<your-worker-host>/api/consent/callback`
2. **Certificates & secrets** → create a client secret.
3. **API permissions → Microsoft Graph → Application permissions**: add the full table from
   Option B below (these are what consent links request via `.default`), then grant admin
   consent in your home tenant if you'll also migrate to/from it.
4. Set the Worker secrets:

   ```sh
   wrangler secret put MT_CLIENT_ID      # the app's client id
   wrangler secret put MT_CLIENT_SECRET  # the secret value
   ```

Then in the dashboard: **Connectors → Add connector → Admin consent link**, name it,
and send the generated link to the target tenant's Global Admin. When they approve,
Microsoft redirects to the callback, dolop binds their tenant id (the link is HMAC-signed
and single-purpose), verifies connectivity, and the connector goes green. If verification
races service-principal propagation, click **Verify** a minute later.

> Note: with Option A a single app identity can access every consented tenant. For
> stricter isolation between engagements, use Option B, and either way consider Exchange
> [application access policies](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
> to scope mailbox access. Tenants can revoke at any time by deleting the enterprise
> application from their directory.

## Option B — Entra ID app registration (repeat in BOTH tenants)

1. **Entra admin center → App registrations → New registration**
   - Name: `dolop-migration`
   - Supported account types: *Accounts in this organizational directory only*
   - No redirect URI needed.
2. **Certificates & secrets → New client secret.** Copy the secret **value** immediately.
3. **API permissions → Add a permission → Microsoft Graph → Application permissions**, add:

   | Permission | Used for |
   | --- | --- |
   | `User.Read.All` | user discovery, UPN→id resolution |
   | `Organization.Read.All` | connector verification, license SKUs |
   | `Mail.ReadWrite` | mailbox folders, messages, attachments |
   | `MailboxSettings.ReadWrite` | inbox rules, auto-replies, time zone, categories |
   | `Calendars.ReadWrite` | calendars and events |
   | `Contacts.ReadWrite` | contact folders and contacts |
   | `Tasks.ReadWrite.All` | Microsoft To Do lists and tasks |
   | `Files.ReadWrite.All` | OneDrive content |
   | `Sites.Read.All` | drive metadata lookups |
   | `User.ReadWrite.All` *(destination only)* | provisioning destination accounts + license assignment |

   A pure **source** tenant can be granted the `.Read` variants instead
   (`Mail.Read`, `Calendars.Read`, `Contacts.Read`, `Tasks.Read.All`, `Files.Read.All`,
   `MailboxSettings.Read`) — dolop only reads from the source. Granting the ReadWrite set in
   both tenants lets you reuse one registration template and reverse migration direction.

4. **Grant admin consent** for the tenant (button at the top of the API permissions page).
5. Note the **Directory (tenant) ID** and **Application (client) ID** from the Overview page.

> **Security tip:** scope the app with an [application access policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
> (`New-ApplicationAccessPolicy`) to restrict mailbox access to a mail-enabled security group
> containing only in-scope users.

## 2. Cloudflare resources

```sh
npm install

wrangler d1 create dolop                  # → copy database_id into wrangler.jsonc
wrangler kv namespace create KV           # → copy id into wrangler.jsonc
wrangler r2 bucket create dolop-artifacts
wrangler queues create dolop-migrations
wrangler queues create dolop-dlq
```

Edit `wrangler.jsonc` and replace `REPLACE_WITH_D1_DATABASE_ID` and
`REPLACE_WITH_KV_NAMESPACE_ID` with the generated ids.

## 3. Secrets

```sh
openssl rand -base64 32 | wrangler secret put ENCRYPTION_KEY
openssl rand -hex 32    | wrangler secret put API_TOKEN
```

- `ENCRYPTION_KEY` — AES-256-GCM master key; tenant client secrets are encrypted with it
  before touching D1. **Set it once and treat it as permanent**: if it changes (including a
  CI deploy syncing a different `DOLOP_ENCRYPTION_KEY` GitHub secret), every stored connector
  secret becomes undecryptable and must be re-entered via *Connectors → Rotate secret*.
- `API_TOKEN` — bearer token for the API. Day-to-day dashboard access uses username/password
  accounts (created on first visit); the token is for automation/CI and for resetting
  operator passwords if they're all forgotten (sign in with the token → Account → Team →
  Reset password).

For local development create `.dev.vars`:

```
ENCRYPTION_KEY=<base64 32 bytes>
API_TOKEN=dev-token
```

## 4. Migrate schema and deploy

```sh
npm run db:migrate        # applies migrations/ to the remote D1 database
npm run deploy
```

Open the printed `*.workers.dev` URL (or your custom domain), sign in with the API token,
then:

1. **Connectors** → add both tenants → **Verify** each (checks token + core permissions).
2. **Projects** → create a project, assign source/destination connectors.
3. Follow [the runbook](runbook.md).

## 5. Recommended: Cloudflare Access

Add the Worker's hostname as a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
so reaching the dashboard requires your IdP login before the API token is even prompted.
Service tokens can be issued for automation.
