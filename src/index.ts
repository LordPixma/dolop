// Dolop Worker entry point: API router, queue consumer (migration fan-out),
// and cron handler (auto-delta scheduling + stalled-migration watchdog).

import { Hono } from 'hono';
import { authApi } from './api/auth';
import { connectorsApi } from './api/connectors';
import { ApiError } from './api/helpers';
import { migrationsApi } from './api/migrations';
import { projectsApi } from './api/projects';
import { reportsApi } from './api/reports';
import { usersApi } from './api/users';
import { requireAuth } from './auth';
import { verifyState } from './crypto';
import {
  bindConsentTenant,
  getConnector,
  getProject,
  listAllProjectUsers,
  listProjects,
  logEvent,
  updateConnectorVerify,
  updateUserStatus,
} from './db';
import { GraphAuthError, GraphClient, GraphError } from './graph/client';
import type { Organization } from './graph/types';
import type { CoordinatorEnqueueBody, Env, PassConfig, QueueMessage } from './types';

export { MigrationOrchestrator } from './do/orchestrator';
export { ProjectCoordinator } from './do/coordinator';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'dolop' }));

function consentPage(title: string, detail: string, ok: boolean): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>dolop</title>
     <style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:90vh}
     .box{max-width:460px;background:#161b22;border:1px solid #2d3646;border-radius:10px;padding:2rem;text-align:center}
     a{color:#58a6ff}</style></head><body><div class="box">
     <h2>${ok ? '✅' : '⚠️'} ${title}</h2><p>${detail}</p>
     <p><a href="/#/connectors">Open the dolop dashboard</a></p></div></body></html>`,
    { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

// Admin-consent return leg. Unauthenticated by design: the person consenting is
// the *target tenant's* Global Admin, not necessarily a dolop operator. The
// HMAC-signed state parameter is what authenticates the request.
app.get('/api/consent/callback', async (c) => {
  const q = c.req.query();
  if (q.error) {
    return consentPage('Consent was not granted', q.error_description ?? q.error ?? 'unknown error', false);
  }
  if (q.admin_consent !== 'True' || !q.tenant || !q.state) {
    return consentPage('Incomplete response', 'Microsoft did not confirm admin consent.', false);
  }
  const payload = await verifyState(q.state, c.env.ENCRYPTION_KEY);
  if (!payload?.cid) {
    return consentPage('Invalid or expired link', 'Ask the dolop operator for a fresh consent link.', false);
  }
  const connector = await getConnector(c.env.DB, payload.cid);
  if (!connector || connector.authMode !== 'consent') {
    return consentPage('Unknown connector', 'This consent link does not match any pending connector.', false);
  }
  await bindConsentTenant(c.env.DB, connector.id, q.tenant);

  // Best-effort immediate verification; the service principal can take a
  // minute to propagate, so failure here is not fatal.
  let detail = 'Consent received. The dolop operator can now verify and use this connector.';
  if (c.env.MT_CLIENT_ID && c.env.MT_CLIENT_SECRET) {
    try {
      const client = new GraphClient(
        { tenantId: q.tenant, clientId: c.env.MT_CLIENT_ID, clientSecret: c.env.MT_CLIENT_SECRET },
        c.env.KV
      );
      const org = await client.get<{ value: Organization[] }>('/organization?$select=displayName,verifiedDomains');
      const tenant = org.value?.[0];
      const domains = (tenant?.verifiedDomains ?? []).map((d) => d.name).filter(Boolean).join(', ');
      await updateConnectorVerify(c.env.DB, connector.id, 'ok', `${tenant?.displayName ?? 'tenant'} (${domains})`);
      detail = `Connected to ${tenant?.displayName ?? q.tenant}. You can close this window.`;
    } catch {
      await updateConnectorVerify(
        c.env.DB,
        connector.id,
        'failed',
        'consent received; first verification failed (service principal may still be propagating) — click Verify in a minute'
      );
    }
  }
  await logEvent(c.env.DB, { message: `admin consent granted for connector ${connector.name} (tenant ${q.tenant})` }).catch(() => undefined);
  return consentPage('Tenant connected', detail, true);
});

// Auth routes manage their own access rules (login/setup must be public).
app.route('/api/auth', authApi);

app.use('/api/*', requireAuth);
app.route('/api/connectors', connectorsApi);
app.route('/api/projects', projectsApi);
app.route('/api/projects', usersApi);
app.route('/api/projects', migrationsApi);
app.route('/api/projects', reportsApi);

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status);
  if (err instanceof GraphAuthError) return c.json({ error: err.message }, 502);
  if (err instanceof GraphError) {
    return c.json({ error: `Microsoft Graph: ${err.code}: ${err.message}` }, 502);
  }
  console.error('unhandled API error', err);
  // Operator-facing admin tool: surface the underlying message so failures are
  // diagnosable from the dashboard instead of requiring a wrangler tail.
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: `internal error: ${message}` }, 500);
});

// Non-API requests are served by static assets (run_worker_first limits the
// Worker to /api/*); this fallback covers local dev edge cases.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

async function enqueueToCoordinator(
  env: Env,
  projectId: string,
  userIds: string[],
  pass: PassConfig,
  maxConcurrent: number
): Promise<void> {
  const body: CoordinatorEnqueueBody = {
    projectId,
    maxConcurrent,
    users: userIds.map((userId) => ({ userId, pass })),
  };
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(projectId));
  const res = await stub.fetch('https://do/enqueue', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`coordinator enqueue failed (HTTP ${res.status})`);
}

async function handleQueueMessage(env: Env, msg: QueueMessage): Promise<void> {
  if (msg.type === 'enqueue-users') {
    const project = await getProject(env.DB, msg.projectId);
    if (!project) return;
    await enqueueToCoordinator(
      env,
      msg.projectId,
      msg.userIds,
      msg.pass,
      project.settings.maxConcurrentUsers
    );
    return;
  }
  if (msg.type === 'auto-delta') {
    const project = await getProject(env.DB, msg.projectId);
    if (!project?.settings.autoDeltaEnabled) return;
    const users = await listAllProjectUsers(env.DB, msg.projectId);
    const eligible = users.filter(
      (u) => u.status === 'completed' || u.status === 'completed_with_errors'
    );
    if (eligible.length === 0) return;
    const pass: PassConfig = {
      passType: 'delta',
      workloads: project.settings.defaultWorkloads,
      filters: {},
    };
    for (const u of eligible) {
      await updateUserStatus(env.DB, u.id, { status: 'queued', passType: 'delta', error: null });
    }
    await enqueueToCoordinator(
      env,
      msg.projectId,
      eligible.map((u) => u.id),
      pass,
      project.settings.maxConcurrentUsers
    );
    await logEvent(env.DB, {
      projectId: msg.projectId,
      message: `automatic delta pass scheduled for ${eligible.length} user(s)`,
    });
  }
}

async function runScheduled(env: Env): Promise<void> {
  // 1. Watchdog: re-arm orchestrators whose alarm chain stalled (no heartbeat
  //    for 10+ minutes while marked running).
  const stale = await env.DB.prepare(
    `SELECT id, project_id FROM migration_users
     WHERE status = 'running'
       AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', '-10 minutes'))
     LIMIT 100`
  ).all<{ id: string; project_id: string }>();
  for (const row of stale.results) {
    const stub = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName(`${row.project_id}/${row.id}`));
    await stub.fetch('https://do/resume', { method: 'POST', body: '{}' }).catch(() => undefined);
  }

  // 2. Auto-delta: for opted-in projects with no active work, schedule a delta
  //    pass once the configured interval has elapsed since the last completion.
  const projects = await listProjects(env.DB);
  for (const project of projects) {
    if (!project.settings.autoDeltaEnabled || project.status !== 'active') continue;
    const counts = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('running','queued') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status IN ('completed','completed_with_errors') THEN 1 ELSE 0 END) AS done,
         MAX(completed_at) AS last_completed
       FROM migration_users WHERE project_id = ?`
    )
      .bind(project.id)
      .first<{ active: number | null; done: number | null; last_completed: string | null }>();
    if (!counts || (counts.active ?? 0) > 0 || (counts.done ?? 0) === 0 || !counts.last_completed) {
      continue;
    }
    const intervalMs = (project.settings.autoDeltaIntervalMinutes ?? 240) * 60_000;
    if (Date.now() - Date.parse(counts.last_completed) < intervalMs) continue;
    await env.MIGRATION_QUEUE.send({ type: 'auto-delta', projectId: project.id });
  }
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleQueueMessage(env, message.body);
        message.ack();
      } catch (e) {
        console.error('queue message failed', e);
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
