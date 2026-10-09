// Admin-consent return leg. Unauthenticated by design: the person consenting
// is the *target tenant's* Global Admin, not necessarily a dolop operator. The
// HMAC-signed state parameter ties the request to the connector it was issued
// for.
//
// Microsoft's admin-consent redirect is a plain query string — `tenant` is not
// signed — so on its own it only proves that *someone* holding a valid state
// visited the callback. With one workspace that's fine (only that workspace's
// operators can mint states). Once several workspaces share this deployment's
// multi-tenant app, a member of one workspace could otherwise bind a tenant
// that consented for a different workspace just by editing `tenant`. So in
// that case binding needs a second leg: an OpenID Connect sign-in at the
// claimed tenant, whose `tid` comes back from Microsoft's token endpoint. In
// every mode a tenant can be bound by consent in at most one workspace.

import { Hono, type Context } from 'hono';
import { countWorkspaces, registrationOpen } from '../accounts';
import { decodeJwtPayload, signState, verifyState } from '../crypto';
import { bindConsentTenant, consentTenantOwner, getConnector, logEvent, updateConnectorVerify } from '../db';
import { GraphClient } from '../graph/client';
import type { Organization } from '../graph/types';
import type { AppEnv, Connector, Env } from '../types';
import { escapeHtml } from '../util';

export const consentApi = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNIN_STATE_TTL_MS = 15 * 60 * 1000;

function consentPage(title: string, detail: string, ok: boolean): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>dolop</title>
     <style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:90vh}
     .box{max-width:460px;background:#161b22;border:1px solid #2d3646;border-radius:10px;padding:2rem;text-align:center}
     a{color:#58a6ff}</style></head><body><div class="box">
     <h2>${ok ? '✅' : '⚠️'} ${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>
     <p><a href="/#/connectors">Open the dolop dashboard</a></p></div></body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    }
  );
}

function redirectUri(c: Ctx): string {
  return `${new URL(c.req.url).origin}/api/consent/callback`;
}

/** Multiple workspaces can exist → a tenant id must be proven, not asserted. */
async function requiresSignInProof(env: Env): Promise<boolean> {
  return registrationOpen(env) || (await countWorkspaces(env.DB)) > 1;
}

async function loadConsentConnector(env: Env, id: string | undefined): Promise<Connector | null> {
  const connector = id ? await getConnector(env.DB, id) : null;
  return connector && connector.authMode === 'consent' ? connector : null;
}

/** Bind the tenant to the connector (unless another workspace owns it) and verify. */
async function bindTenant(c: Ctx, connector: Connector, tenantId: string): Promise<Response> {
  if (await consentTenantOwner(c.env.DB, tenantId, connector.workspaceId)) {
    return consentPage(
      'Tenant already connected elsewhere',
      'This tenant is already connected to a different dolop workspace. Ask that workspace to delete its ' +
        'connector, or contact the operator of this dolop deployment.',
      false
    );
  }
  await bindConsentTenant(c.env.DB, connector.id, tenantId);

  // Best-effort immediate verification; the service principal can take a
  // minute to propagate, so failure here is not fatal.
  let detail = 'Consent received. The dolop operator can now verify and use this connector.';
  if (c.env.MT_CLIENT_ID && c.env.MT_CLIENT_SECRET) {
    try {
      const client = new GraphClient(
        { tenantId, clientId: c.env.MT_CLIENT_ID, clientSecret: c.env.MT_CLIENT_SECRET },
        c.env.KV
      );
      const org = await client.get<{ value: Organization[] }>('/organization?$select=displayName,verifiedDomains');
      const tenant = org.value?.[0];
      const domains = (tenant?.verifiedDomains ?? []).map((d) => d.name).filter(Boolean).join(', ');
      await updateConnectorVerify(c.env.DB, connector.id, 'ok', `${tenant?.displayName ?? 'tenant'} (${domains})`);
      detail = `Connected to ${tenant?.displayName ?? tenantId}. You can close this window.`;
    } catch {
      await updateConnectorVerify(
        c.env.DB,
        connector.id,
        'failed',
        'consent received; first verification failed (service principal may still be propagating) — click Verify in a minute'
      );
    }
  }
  await logEvent(c.env.DB, {
    message: `admin consent granted for connector ${connector.name} (tenant ${tenantId})`,
  }).catch(() => undefined);
  return consentPage('Tenant connected', detail, true);
}

/** Leg 1: Microsoft's admin-consent redirect. */
async function handleAdminConsent(c: Ctx, q: Record<string, string>): Promise<Response> {
  if (q.admin_consent !== 'True' || !q.tenant || !q.state) {
    return consentPage('Incomplete response', 'Microsoft did not confirm admin consent.', false);
  }
  const payload = await verifyState(q.state, c.env.ENCRYPTION_KEY);
  if (!payload?.cid || payload.step) {
    return consentPage('Invalid or expired link', 'Ask the dolop operator for a fresh consent link.', false);
  }
  const connector = await loadConsentConnector(c.env, payload.cid);
  if (!connector) {
    return consentPage('Unknown connector', 'This consent link does not match any pending connector.', false);
  }
  if (!GUID.test(q.tenant)) {
    return consentPage('Incomplete response', 'Microsoft returned an unexpected tenant identifier.', false);
  }
  if (!(await requiresSignInProof(c.env))) return bindTenant(c, connector, q.tenant);

  if (!c.env.MT_CLIENT_ID || !c.env.MT_CLIENT_SECRET) {
    return consentPage('Not configured', 'The MT_CLIENT_ID/MT_CLIENT_SECRET secrets are not set on this deployment.', false);
  }
  // Leg 2: have the admin sign in at the tenant they consented for, so the
  // tenant id can be taken from a token Microsoft issues rather than the URL.
  const state = await signState(
    { cid: connector.id, tid: q.tenant.toLowerCase(), step: 'signin' },
    c.env.ENCRYPTION_KEY,
    SIGNIN_STATE_TTL_MS
  );
  const authorizeUrl =
    `https://login.microsoftonline.com/${encodeURIComponent(q.tenant)}/oauth2/v2.0/authorize` +
    `?client_id=${encodeURIComponent(c.env.MT_CLIENT_ID)}` +
    '&response_type=code&response_mode=query' +
    `&redirect_uri=${encodeURIComponent(redirectUri(c))}` +
    `&scope=${encodeURIComponent('openid profile')}` +
    `&state=${encodeURIComponent(state)}`;
  return c.redirect(authorizeUrl, 302);
}

/** Leg 2: the sign-in redirect carrying an authorization code. */
async function handleSignIn(c: Ctx, q: Record<string, string>): Promise<Response> {
  const payload = q.state ? await verifyState(q.state, c.env.ENCRYPTION_KEY) : null;
  if (!payload?.cid || !payload.tid || payload.step !== 'signin') {
    return consentPage('Invalid or expired link', 'Ask the dolop operator for a fresh consent link.', false);
  }
  const connector = await loadConsentConnector(c.env, payload.cid);
  if (!connector) {
    return consentPage('Unknown connector', 'This consent link does not match any pending connector.', false);
  }
  if (!c.env.MT_CLIENT_ID || !c.env.MT_CLIENT_SECRET) {
    return consentPage('Not configured', 'The MT_CLIENT_ID/MT_CLIENT_SECRET secrets are not set on this deployment.', false);
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(payload.tid)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.env.MT_CLIENT_ID,
        client_secret: c.env.MT_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: q.code ?? '',
        redirect_uri: redirectUri(c),
        scope: 'openid profile',
      }),
    }
  );
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error_description?: string };
  const claims = res.ok && body.id_token ? decodeJwtPayload(body.id_token) : null;
  if (!claims) {
    const reason = (body.error_description ?? `HTTP ${res.status}`).split('\n')[0] ?? '';
    return consentPage('Sign-in failed', `Microsoft did not complete the sign-in: ${reason}`, false);
  }
  const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
  if (claims.aud !== c.env.MT_CLIENT_ID || !tid || tid !== payload.tid) {
    return consentPage(
      'Wrong tenant',
      'The account that signed in does not belong to the tenant that granted consent. Sign in with an ' +
        'administrator account of that tenant and try the consent link again.',
      false
    );
  }
  return bindTenant(c, connector, tid);
}

consentApi.get('/callback', async (c) => {
  const q = c.req.query();
  if (q.error) {
    return consentPage('Consent was not granted', q.error_description ?? q.error ?? 'unknown error', false);
  }
  return q.code ? handleSignIn(c, q) : handleAdminConsent(c, q);
});
