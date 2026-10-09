// Project CRUD and project-level summary.

import { Hono } from 'hono';
import {
  createProject,
  deleteProject,
  getConnector,
  listAllProjectUsers,
  listProjects,
  projectUserSummary,
  updateProject,
} from '../db';
import type { AppEnv, Env, Project, WorkloadStats } from '../types';
import { nowIso } from '../util';
import { ApiError, loadProject, sanitizeSettings } from './helpers';

export const projectsApi = new Hono<AppEnv>();

/** Reject connector ids that don't exist in the caller's workspace. */
async function assertConnectorsInWorkspace(
  env: Env,
  workspaceId: string,
  ids: { source?: string; destination?: string }
): Promise<void> {
  for (const [role, id] of Object.entries(ids)) {
    if (!id) continue;
    const connector = await getConnector(env.DB, id);
    if (!connector || connector.workspaceId !== workspaceId) {
      throw new ApiError(400, `${role} connector ${id} not found`);
    }
  }
}

projectsApi.get('/', async (c) => {
  const projects = await listProjects(c.env.DB, c.var.workspaceId);
  const withSummary = await Promise.all(
    projects.map(async (p) => ({ ...p, userSummary: await projectUserSummary(c.env.DB, p.id) }))
  );
  return c.json({ projects: withSummary });
});

projectsApi.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    sourceConnectorId?: string;
    destConnectorId?: string;
    settings?: unknown;
  };
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  await assertConnectorsInWorkspace(c.env, c.var.workspaceId, {
    source: body.sourceConnectorId,
    destination: body.destConnectorId,
  });
  const id = await createProject(c.env.DB, {
    workspaceId: c.var.workspaceId,
    name: body.name,
    description: body.description,
    sourceConnectorId: body.sourceConnectorId,
    destConnectorId: body.destConnectorId,
    settings: sanitizeSettings(body.settings),
  });
  return c.json({ id }, 201);
});

projectsApi.get('/:projectId', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const [summary, source, dest] = await Promise.all([
    projectUserSummary(c.env.DB, project.id),
    project.sourceConnectorId ? getConnector(c.env.DB, project.sourceConnectorId) : null,
    project.destConnectorId ? getConnector(c.env.DB, project.destConnectorId) : null,
  ]);
  const safe = (con: Awaited<ReturnType<typeof getConnector>>) => {
    if (!con) return null;
    const { clientSecretEnc: _omit, ...rest } = con;
    return rest;
  };
  return c.json({
    project,
    userSummary: summary,
    sourceConnector: safe(source),
    destConnector: safe(dest),
  });
});

// Live aggregate progress across the whole project, for the dashboard.
projectsApi.get('/:projectId/progress', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const users = await listAllProjectUsers(c.env.DB, project.id);

  const zero = (): Required<WorkloadStats> => ({
    discovered: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    expected: 0,
    expectedBytes: 0,
  });
  const totals = zero();
  const byWorkload: Record<string, Required<WorkloadStats>> = {};
  const statusCounts: Record<string, number> = {};
  const active: unknown[] = [];

  for (const u of users) {
    statusCounts[u.status] = (statusCounts[u.status] ?? 0) + 1;
    for (const [key, s] of Object.entries(u.stats)) {
      if (key.startsWith('assessment')) continue;
      const bucket = (byWorkload[key] ??= zero());
      for (const target of [bucket, totals]) {
        target.discovered += s.discovered ?? 0;
        target.migrated += s.migrated ?? 0;
        target.skipped += s.skipped ?? 0;
        target.failed += s.failed ?? 0;
        target.bytes += s.bytes ?? 0;
        target.expected += s.expected ?? 0;
        target.expectedBytes += s.expectedBytes ?? 0;
      }
    }
    if (u.status === 'running') {
      active.push({
        id: u.id,
        sourceUpn: u.sourceUpn,
        displayName: u.displayName,
        passType: u.passType,
        passConfig: u.passConfig,
        activity: u.activity,
        stats: u.stats,
        startedAt: u.startedAt,
        heartbeatAt: u.heartbeatAt,
      });
    }
  }

  return c.json({
    totals,
    byWorkload,
    statusCounts,
    active: active.slice(0, 50),
    userCount: users.length,
    generatedAt: nowIso(),
  });
});

projectsApi.patch('/:projectId', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    sourceConnectorId?: string;
    destConnectorId?: string;
    settings?: unknown;
    status?: Project['status'];
  };
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'archived') {
    throw new ApiError(400, 'status must be active or archived');
  }
  await assertConnectorsInWorkspace(c.env, c.var.workspaceId, {
    source: body.sourceConnectorId,
    destination: body.destConnectorId,
  });
  await updateProject(c.env.DB, project.id, {
    name: body.name,
    description: body.description,
    sourceConnectorId: body.sourceConnectorId,
    destConnectorId: body.destConnectorId,
    settings: body.settings === undefined ? undefined : sanitizeSettings(body.settings),
    status: body.status,
  });
  return c.json({ ok: true });
});

projectsApi.delete('/:projectId', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const summary = await projectUserSummary(c.env.DB, project.id);
  if ((summary.running ?? 0) > 0 || (summary.queued ?? 0) > 0) {
    throw new ApiError(409, 'stop all migrations before deleting the project');
  }
  await deleteProject(c.env.DB, project.id);
  return c.json({ ok: true });
});
