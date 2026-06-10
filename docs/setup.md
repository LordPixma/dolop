# Setup guide

Dolop talks to both tenants app-only (client credentials), so each tenant needs one Entra ID
app registration with **application** permissions and admin consent. The Cloudflare side is a
single Worker plus D1/KV/R2/Queues.

## 1. Entra ID app registration (repeat in BOTH tenants)

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
  before touching D1. Losing it means re-entering connector secrets.
- `API_TOKEN` — bearer token required by every `/api` route and by the dashboard sign-in.

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
