// Migration control: start a pass (assessment / pre-stage / full / delta),
// stop, inspect the coordinator queue, and browse item errors and events.

import { Hono } from 'hono';
import { listAllProjectUsers, listEvents, listItemErrors, logEvent, updateUserStatus } from '../db';
import type { Env, PassConfig, PassType, Workload } from '../types';
import { ALL_WORKLOADS } from '../types';
import { chunkArray } from '../util';
import { ApiError, loadProject } from './helpers';

export const migrationsApi = new Hono<{ Bindings: Env }>();

const PASS_TYPES: PassType[] = ['assessment', 'prestage', 'full', 'delta'];

migrationsApi.post('/:projectId/start', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  if (!project.sourceConnectorId || !project.destConnectorId) {
    throw new ApiError(400, 'assign source and destination connectors to the project first');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    passType?: PassType;
    workloads?: Workload[];
    filters?: PassConfig['filters'];
    userIds?: string[];
  };
  const passType = body.passType ?? 'full';
  if (!PASS_TYPES.includes(passType)) throw new ApiError(400, `passType must be one of ${PASS_TYPES.join(', ')}`);
  const workloads = (body.workloads?.length ? body.workloads : project.settings.defaultWorkloads).filter(
    (w): w is Workload => (ALL_WORKLOADS as string[]).includes(w)
  );
  if (passType !== 'assessment' && workloads.length === 0) {
    throw new ApiError(400, 'select at least one workload');
  }
  if (passType === 'prestage' && !body.filters?.mailReceivedBefore) {
    throw new ApiError(400, 'prestage requires filters.mailReceivedBefore (the cutoff date)');
  }
  const pass: PassConfig = { passType, workloads, filters: body.filters ?? {} };

  let userIds = body.userIds;
  if (!userIds?.length) {
    const users = await listAllProjectUsers(c.env.DB, project.id);
    userIds = users.filter((u) => u.status !== 'running' && u.status !== 'queued').map((u) => u.id);
  }
  if (userIds.length === 0) throw new ApiError(400, 'no eligible users to start');

  for (const id of userIds) {
    await updateUserStatus(c.env.DB, id, { status: 'queued', passType, error: null });
  }
  for (const batch of chunkArray(userIds, 100)) {
    await c.env.MIGRATION_QUEUE.send({ type: 'enqueue-users', projectId: project.id, userIds: batch, pass });
  }
  await logEvent(c.env.DB, {
    projectId: project.id,
    message: `${passType} pass started for ${userIds.length} user(s) [${workloads.join(', ')}]`,
  });
  return c.json({ ok: true, queued: userIds.length, pass });
});

migrationsApi.post('/:projectId/stop', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const body = (await c.req.json().catch(() => ({}))) as { userIds?: string[] };
  const stub = c.env.COORDINATOR.get(c.env.COORDINATOR.idFromName(project.id));
  const res = await stub.fetch('https://do/stop', {
    method: 'POST',
    body: JSON.stringify({ userIds: body.userIds }),
    headers: { 'content-type': 'application/json' },
  });
  const result = (await res.json()) as { dequeued?: string[]; signaled?: string[] };

  // Users marked queued in D1 but not yet (or no longer) in the coordinator's
  // queue would otherwise linger — settle them to stopped as well.
  const users = await listAllProjectUsers(c.env.DB, project.id);
  const scope = body.userIds ? new Set(body.userIds) : null;
  for (const u of users) {
    if (u.status === 'queued' && (!scope || scope.has(u.id)) && !result.signaled?.includes(u.id)) {
      await updateUserStatus(c.env.DB, u.id, { status: 'stopped' });
    }
  }

  await logEvent(c.env.DB, {
    projectId: project.id,
    message: `stop requested (${result.dequeued?.length ?? 0} dequeued, ${result.signaled?.length ?? 0} running signaled)`,
  });
  return c.json({ ok: true, ...result });
});

migrationsApi.get('/:projectId/queue', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const stub = c.env.COORDINATOR.get(c.env.COORDINATOR.idFromName(project.id));
  const res = await stub.fetch('https://do/status');
  return c.json(await res.json());
});

migrationsApi.get('/:projectId/errors', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const result = await listItemErrors(c.env.DB, project.id, {
    userId: c.req.query('userId'),
    limit: parseInt(c.req.query('limit') ?? '100', 10),
    offset: parseInt(c.req.query('offset') ?? '0', 10),
  });
  return c.json(result);
});

migrationsApi.get('/:projectId/events', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  return c.json({ events: await listEvents(c.env.DB, project.id, { limit: 200 }) });
});
