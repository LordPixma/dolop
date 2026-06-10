// Tenant connector endpoints. A connector holds the Entra ID app registration
// for one tenant (tenant id + client id + encrypted client secret) and can be
// used as either side of any project.

import { Hono } from 'hono';
import { decryptSecret, encryptSecret } from '../crypto';
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

connectorsApi.get('/:id', async (c) => {
  const connector = await getConnector(c.env.DB, c.req.param('id'));
  if (!connector) return c.json({ error: 'connector not found' }, 404);
  const { clientSecretEnc: _omit, ...safe } = connector;
  return c.json({ connector: safe });
});

connectorsApi.patch('/:id', async (c) => {
  const connector = await getConnector(c.env.DB, c.req.param('id'));
  if (!connector) return c.json({ error: 'connector not found' }, 404);
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
  const clientSecret = await decryptSecret(connector.clientSecretEnc, c.env.ENCRYPTION_KEY);
  const client = new GraphClient(
    { tenantId: connector.tenantId, clientId: connector.clientId, clientSecret },
    c.env.KV
  );
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
