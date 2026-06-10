// Tenant connector endpoints. A connector holds the Entra ID app registration
// for one tenant (tenant id + client id + encrypted client secret) and can be
// used as either side of any project.

import { Hono } from 'hono';
import { encryptSecret, signState } from '../crypto';
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  listProjects,
  updateConnectorSecret,
  updateConnectorVerify,
} from '../db';
import { GraphAuthError, GraphClient, GraphError } from '../graph/client';
import type { Organization } from '../graph/types';
import type { Env } from '../types';
import { credsForConnector } from './helpers';

export const connectorsApi = new Hono<{ Bindings: Env }>();

connectorsApi.get('/', async (c) => {
  return c.json({ connectors: await listConnectors(c.env.DB) });
});

connectorsApi.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  };
  if (!body.name || !body.tenantId || !body.clientId || !body.clientSecret) {
    return c.json({ error: 'name, tenantId, clientId and clientSecret are required' }, 400);
  }
  const clientSecretEnc = await encryptSecret(body.clientSecret, c.env.ENCRYPTION_KEY);
  const id = await createConnector(c.env.DB, {
    name: body.name,
    tenantId: body.tenantId,
    clientId: body.clientId,
    clientSecretEnc,
  });
  return c.json({ id }, 201);
});

// Create a connector in admin-consent mode and return the link to send to the
// target tenant's Global Administrator. When they approve, Microsoft redirects
// to /api/consent/callback, which binds their tenant id to this connector.
connectorsApi.post('/consent-link', async (c) => {
  if (!c.env.MT_CLIENT_ID || !c.env.MT_CLIENT_SECRET) {
    return c.json(
      {
        error:
          'Admin-consent mode requires the MT_CLIENT_ID and MT_CLIENT_SECRET secrets ' +
          '(your multi-tenant Entra app). See docs/setup.md, or add the connector with ' +
          'manual credentials instead.',
      },
      422
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  if (!body.name) return c.json({ error: 'name is required' }, 400);

  const id = await createConnector(c.env.DB, {
    name: body.name,
    tenantId: '',
    clientId: c.env.MT_CLIENT_ID,
    clientSecretEnc: '',
    authMode: 'consent',
    verifyStatus: 'pending_consent',
  });
  const state = await signState({ cid: id }, c.env.ENCRYPTION_KEY, 7 * 24 * 60 * 60 * 1000);
  const redirectUri = `${new URL(c.req.url).origin}/api/consent/callback`;
  const consentUrl =
    'https://login.microsoftonline.com/organizations/v2.0/adminconsent' +
    `?client_id=${encodeURIComponent(c.env.MT_CLIENT_ID)}` +
    `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  return c.json({ id, consentUrl, redirectUri }, 201);
});

connectorsApi.get('/:id', async (c) => {
  const connector = await getConnector(c.env.DB, c.req.param('id'));
  if (!connector) return c.json({ error: 'connector not found' }, 404);
  const { clientSecretEnc: _omit, ...safe } = connector;
  return c.json({ connector: safe });
});

// Re-issue the consent link for an existing consent-mode connector (links are
// HMAC-signed and expire after 7 days; re-consent is also harmless).
connectorsApi.post('/:id/consent-link', async (c) => {
  const connector = await getConnector(c.env.DB, c.req.param('id'));
  if (!connector) return c.json({ error: 'connector not found' }, 404);
  if (connector.authMode !== 'consent') {
    return c.json({ error: 'not a consent-mode connector' }, 400);
  }
  if (!c.env.MT_CLIENT_ID) {
    return c.json({ error: 'MT_CLIENT_ID secret is not configured' }, 422);
  }
  const state = await signState({ cid: connector.id }, c.env.ENCRYPTION_KEY, 7 * 24 * 60 * 60 * 1000);
  const redirectUri = `${new URL(c.req.url).origin}/api/consent/callback`;
  const consentUrl =
    'https://login.microsoftonline.com/organizations/v2.0/adminconsent' +
    `?client_id=${encodeURIComponent(c.env.MT_CLIENT_ID)}` +
    `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  return c.json({ id: connector.id, consentUrl, redirectUri });
});

connectorsApi.patch('/:id', async (c) => {
  const connector = await getConnector(c.env.DB, c.req.param('id'));
  if (!connector) return c.json({ error: 'connector not found' }, 404);
  if (connector.authMode === 'consent') {
    return c.json(
      { error: 'consent connectors have no per-connector secret — rotate the MT_CLIENT_SECRET Worker secret instead' },
      400
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { clientSecret?: string };
  if (!body.clientSecret) return c.json({ error: 'clientSecret is required' }, 400);
  await updateConnectorSecret(
    c.env.DB,
    connector.id,
    await encryptSecret(body.clientSecret, c.env.ENCRYPTION_KEY)
  );
  return c.json({ ok: true });
});

connectorsApi.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const projects = await listProjects(c.env.DB);
  const used = projects.filter((p) => p.sourceConnectorId === id || p.destConnectorId === id);
  if (used.length > 0) {
    return c.json(
      { error: `connector is used by project(s): ${used.map((p) => p.name).join(', ')}` },
      409
    );
  }
  await deleteConnector(c.env.DB, id);
  return c.json({ ok: true });
});

// Verifies credentials and core Graph permissions; records the result.
connectorsApi.post('/:id/verify', async (c) => {
  const connector = await getConnector(c.env.DB, c.req.param('id'));
  if (!connector) return c.json({ error: 'connector not found' }, 404);
  if (connector.authMode === 'consent' && !connector.tenantId) {
    return c.json(
      { ok: false, error: 'waiting for a tenant admin to approve the consent link' },
      422
    );
  }
  const client = new GraphClient(await credsForConnector(c.env, connector), c.env.KV);
  try {
    const org = await client.get<{ value: Organization[] }>(
      '/organization?$select=displayName,verifiedDomains'
    );
    await client.get('/users?$top=1&$select=id'); // exercises User.Read.All
    const tenant = org.value?.[0];
    const domains = (tenant?.verifiedDomains ?? [])
      .map((d) => d.name)
      .filter(Boolean)
      .join(', ');
    const detail = `${tenant?.displayName ?? 'tenant'} (${domains})`;
    await updateConnectorVerify(c.env.DB, connector.id, 'ok', detail);
    return c.json({ ok: true, detail });
  } catch (e) {
    const message =
      e instanceof GraphAuthError
        ? e.message
        : e instanceof GraphError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
    await updateConnectorVerify(c.env.DB, connector.id, 'failed', message);
    return c.json({ ok: false, error: message }, 422);
  }
});
