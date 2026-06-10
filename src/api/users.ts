// User scoping: discovery from the source tenant, mapping (auto-map by domain,
// explicit mappings, CSV import), provisioning into the destination tenant
// (user creation + license assignment), and per-user detail.

import { Hono } from 'hono';
import { deleteUser, getUser, listItemErrors, listUsers, updateUserStatus, upsertUsers } from '../db';
import { GraphError } from '../graph/client';
import type { GraphUser, SubscribedSku } from '../graph/types';
import type { Env } from '../types';
import { mapUpnToDomain, parseMappingCsv } from '../util';
import { ApiError, generatePassword, graphForConnector, loadProject } from './helpers';

export const usersApi = new Hono<{ Bindings: Env }>();

// Discover users in the source tenant (optionally filtered with an OData $filter).
usersApi.post('/:projectId/discover', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const { client } = await graphForConnector(c.env, project.sourceConnectorId, 'source');
  const body = (await c.req.json().catch(() => ({}))) as { filter?: string };

  const select = '$select=id,userPrincipalName,displayName,mail,accountEnabled,assignedLicenses';
  let url = `/users?${select}&$top=500`;
  if (body.filter) url += `&$filter=${encodeURIComponent(body.filter)}`;

  const users: GraphUser[] = [];
  for (let page = 0; url && page < 8; page++) {
    const res = await client.page<GraphUser>(url, 500);
    users.push(...res.items);
    url = res.nextLink ?? '';
  }
  return c.json({
    users: users.map((u) => ({
      id: u.id,
      userPrincipalName: u.userPrincipalName,
      displayName: u.displayName,
      mail: u.mail,
      accountEnabled: u.accountEnabled,
      licensed: (u.assignedLicenses ?? []).length > 0,
    })),
    truncated: Boolean(url),
  });
});

// Add users to the project scope.
usersApi.post('/:projectId/users', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const body = (await c.req.json().catch(() => ({}))) as {
    mappings?: { sourceUpn: string; destUpn: string; displayName?: string; sourceId?: string }[];
    autoMap?: {
      targetDomain: string;
      users: { sourceUpn: string; displayName?: string; sourceId?: string }[];
    };
  };
  let rows: { sourceUpn: string; destUpn: string; displayName?: string; sourceId?: string }[] = [];
  if (body.mappings?.length) {
    rows = body.mappings.filter((m) => m.sourceUpn?.includes('@') && m.destUpn?.includes('@'));
  } else if (body.autoMap?.targetDomain && body.autoMap.users?.length) {
    rows = body.autoMap.users
      .filter((u) => u.sourceUpn?.includes('@'))
      .map((u) => ({
        sourceUpn: u.sourceUpn,
        destUpn: mapUpnToDomain(u.sourceUpn, body.autoMap!.targetDomain),
        displayName: u.displayName,
        sourceId: u.sourceId,
      }));
  }
  if (rows.length === 0) {
    throw new ApiError(400, 'provide mappings[] or autoMap{targetDomain, users[]}');
  }
  const result = await upsertUsers(c.env.DB, project.id, rows);
  return c.json(result);
});

// CSV import: "sourceUpn,destUpn" per line (optional header).
usersApi.post('/:projectId/users/import', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const text = await c.req.text();
  const { rows, errors } = parseMappingCsv(text);
  if (rows.length === 0) {
    return c.json({ error: 'no valid rows found', parseErrors: errors }, 400);
  }
  const result = await upsertUsers(c.env.DB, project.id, rows);
  return c.json({ ...result, parseErrors: errors });
});

usersApi.get('/:projectId/users', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const result = await listUsers(c.env.DB, project.id, {
    status: c.req.query('status'),
    limit: parseInt(c.req.query('limit') ?? '100', 10),
    offset: parseInt(c.req.query('offset') ?? '0', 10),
  });
  return c.json(result);
});

usersApi.get('/:projectId/users/:userId', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const user = await getUser(c.env.DB, c.req.param('userId'));
  if (!user || user.projectId !== project.id) throw new ApiError(404, 'user not found');
  const { errors } = await listItemErrors(c.env.DB, project.id, { userId: user.id, limit: 50 });
  return c.json({ user, recentErrors: errors });
});

usersApi.delete('/:projectId/users/:userId', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const user = await getUser(c.env.DB, c.req.param('userId'));
  if (!user || user.projectId !== project.id) throw new ApiError(404, 'user not found');
  if (user.status === 'running' || user.status === 'queued') {
    throw new ApiError(409, 'stop the migration before removing this user');
  }
  await deleteUser(c.env.DB, user.id);
  return c.json({ ok: true });
});

// Destination tenant license SKUs (for provisioning).
usersApi.get('/:projectId/skus', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const { client } = await graphForConnector(c.env, project.destConnectorId, 'destination');
  const res = await client.get<{ value: SubscribedSku[] }>(
    '/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits'
  );
  return c.json({
    skus: (res.value ?? []).map((s) => ({
      skuId: s.skuId,
      skuPartNumber: s.skuPartNumber,
      consumedUnits: s.consumedUnits ?? 0,
      enabledUnits: s.prepaidUnits?.enabled ?? 0,
    })),
  });
});

// Provision destination accounts (bulk). Returns one-time passwords — they are
// shown once and never stored.
usersApi.post('/:projectId/provision', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const { client } = await graphForConnector(c.env, project.destConnectorId, 'destination');
  const body = (await c.req.json().catch(() => ({}))) as {
    userIds?: string[];
    usageLocation?: string;
    skuIds?: string[];
  };
  if (!body.userIds?.length) throw new ApiError(400, 'userIds is required');
  if (body.skuIds?.length && !body.usageLocation) {
    throw new ApiError(400, 'usageLocation is required when assigning licenses');
  }

  const results: {
    userId: string;
    destUpn: string;
    status: 'created' | 'exists' | 'failed';
    password?: string;
    error?: string;
  }[] = [];

  for (const userId of body.userIds.slice(0, 50)) {
    const user = await getUser(c.env.DB, userId);
    if (!user || user.projectId !== project.id) {
      results.push({ userId, destUpn: '', status: 'failed', error: 'user not found in project' });
      continue;
    }
    try {
      const existing = await client
        .get<GraphUser>(`/users/${encodeURIComponent(user.destUpn)}?$select=id`)
        .catch((e: unknown) => {
          if (e instanceof GraphError && e.status === 404) return null;
          throw e;
        });
      if (existing) {
        await updateUserStatus(c.env.DB, user.id, { destId: existing.id });
        results.push({ userId, destUpn: user.destUpn, status: 'exists' });
        continue;
      }
      const password = generatePassword();
      const local = user.destUpn.split('@')[0] ?? 'user';
      const created = await client.post<GraphUser>('/users', {
        accountEnabled: true,
        displayName: user.displayName ?? local,
        mailNickname: local.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'user',
        userPrincipalName: user.destUpn,
        usageLocation: body.usageLocation,
        passwordProfile: { password, forceChangePasswordNextSignIn: true },
      });
      if (body.skuIds?.length) {
        await client.post(`/users/${created.id}/assignLicense`, {
          addLicenses: body.skuIds.map((skuId) => ({ skuId, disabledPlans: [] })),
          removeLicenses: [],
        });
      }
      await updateUserStatus(c.env.DB, user.id, { destId: created.id });
      results.push({ userId, destUpn: user.destUpn, status: 'created', password });
    } catch (e) {
      const message =
        e instanceof GraphError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      results.push({ userId, destUpn: user.destUpn, status: 'failed', error: message });
    }
  }
  return c.json({ results });
});
