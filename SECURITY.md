# Security policy

Dolop handles privileged credentials for Microsoft 365 tenants. Security reports are taken
seriously and appreciated.

## Reporting a vulnerability

Please report vulnerabilities **privately** via
[GitHub Security Advisories](https://github.com/LordPixma/dolop/security/advisories/new)
(preferred) rather than public issues. Include reproduction steps and impact. You should
receive an acknowledgement within a few days; please allow a reasonable window for a fix
before public disclosure.

## Threat model summary

| Asset | Protection |
| --- | --- |
| Tenant client secrets | AES-256-GCM encrypted in D1; key exists only as the `ENCRYPTION_KEY` Worker secret; never returned by any API |
| Graph access | App-only client credentials; no user passwords ever collected; tenants can revoke by deleting the enterprise application |
| Operator passwords | PBKDF2-SHA256 (100k iterations, per-password salt) |
| Sessions | 256-bit random token in an HttpOnly/Secure/SameSite=Lax cookie; only the SHA-256 of the token is stored server-side |
| Login | Per-username rate limiting (10 failures → 15-minute lockout) |
| Admin consent flow | HMAC-SHA256-signed, expiring state parameter on the public callback |
| Mailbox data | Streams through the Worker per-request; not persisted (metadata, stats and item-error descriptions only) |

## Hardening checklist for deployments

1. Put the Worker behind **Cloudflare Access** so the dashboard requires your IdP before
   the application login.
2. Scope mailbox access with an **Exchange application access policy**
   (`New-ApplicationAccessPolicy`) so the app can only reach in-scope mailboxes.
3. Set `ENCRYPTION_KEY` once, store it in a password manager, never reuse it elsewhere.
4. Treat `API_TOKEN` like a root credential; rotate it after engagements.
5. Use a dedicated Cloudflare API token (Workers/Queues/D1 edit only) for CI, and delete
   tenant connectors + revoke enterprise-app consent when a migration project ends.
