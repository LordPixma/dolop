// Device agent API. Public routes, authenticated by a per-device bearer token
// (dolop stores only its SHA-256). The agent fetches its plan (which user's
// profile to hand to which destination account), downloads the destination
// provisioning package, and reports every step back here.

import { Hono, type Context } from 'hono';
import { getConnector, getDeviceByAgentToken, getProject, getUser, logEvent, updateDevice } from '../db';
import type { BitLockerKeyRecord, Device, DeviceAgentReport, DeviceStatus, Env } from '../types';
import { nowIso } from '../util';
import { packageInfo, packageKey, saveKeys, sha256Hex } from './devices';

type AgentEnv = { Bindings: Env; Variables: { device: Device } };

export const agentApi = new Hono<AgentEnv>();

/** Bump when the plan/report contract changes; the agent refuses older servers. */
export const AGENT_PROTOCOL = 1;

const MAX_REPORT_BYTES = 64 * 1024;

// The agent script itself holds no secrets: it is served to anyone, and the
// token is passed to it as a parameter.
agentApi.get('/script', async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/agent/dolop-agent.ps1', c.req.url)));
  if (!res.ok) return c.json({ error: 'agent script not found' }, 404);
  return new Response(await res.text(), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
});

async function requireDevice(c: Context<AgentEnv>, next: () => Promise<void>): Promise<Response | void> {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const device = token ? await getDeviceByAgentToken(c.env.DB, await sha256Hex(token)) : null;
  if (!device) {
    return c.json({ error: 'invalid or expired agent token — create a new agent command in dolop' }, 401);
  }
  await updateDevice(c.env.DB, device.id, { agentLastSeenAt: nowIso() });
  c.set('device', device);
  await next();
}

agentApi.use('/plan', requireDevice);
agentApi.use('/package', requireDevice);
agentApi.use('/report', requireDevice);

// Everything the agent needs to move this device.
agentApi.get('/plan', async (c) => {
  const device = c.var.device;
  const project = await getProject(c.env.DB, device.projectId);
  const user = device.userId ? await getUser(c.env.DB, device.userId) : null;
  if (!project || !user || !device.sourceSid || !device.destSid) {
    return c.json({ error: 'device is not paired with a user any more — create a new agent command' }, 409);
  }
  const [src, dst, pkg] = await Promise.all([
    project.sourceConnectorId ? getConnector(c.env.DB, project.sourceConnectorId) : null,
    project.destConnectorId ? getConnector(c.env.DB, project.destConnectorId) : null,
    packageInfo(c.env, project.id),
  ]);
  if (!src?.tenantId || !dst?.tenantId) {
    return c.json({ error: 'project connectors are not configured' }, 409);
  }
  return c.json({
    protocol: AGENT_PROTOCOL,
    device: {
      id: device.id,
      name: device.name,
      entraDeviceId: device.entraDeviceId ?? null,
      status: device.status,
    },
    sourceTenantId: src.tenantId,
    destTenantId: dst.tenantId,
    sourceUser: { upn: user.sourceUpn, sid: device.sourceSid },
    destUser: { upn: user.destUpn, sid: device.destSid },
    package: pkg ? { available: true, sha256: pkg.sha256, size: pkg.size } : { available: false },
  });
});

agentApi.get('/package', async (c) => {
  const obj = await c.env.R2.get(packageKey(c.var.device.projectId));
  if (!obj) return c.json({ error: 'no provisioning package has been uploaded for this project' }, 404);
  await logEvent(c.env.DB, {
    projectId: c.var.device.projectId,
    deviceId: c.var.device.id,
    message: `${c.var.device.name}: agent downloaded the provisioning package`,
  });
  return new Response(obj.body, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
  });
});

interface ReportBody {
  phase?: string;
  step?: string;
  status?: 'ok' | 'info' | 'warn' | 'fail' | 'done';
  detail?: string;
  checks?: DeviceAgentReport['checks'];
  data?: Record<string, unknown>;
  bitlocker?: { id?: string; key?: string; volume?: string }[];
}

/** Device status implied by an agent report, or null to leave it unchanged. */
export function statusForReport(current: DeviceStatus, r: ReportBody): DeviceStatus | null {
  if (current === 'completed' || current === 'cleaned_up') return null;
  if (r.phase === 'check' && r.status === 'done') {
    // A pre-flight re-run never drags a device that is already moving backwards.
    if (['scheduled', 'migrating', 'joined'].includes(current)) return null;
    return r.checks?.some((x) => x.status === 'fail') ? 'check_failed' : 'checked';
  }
  if (r.status === 'fail' && r.phase !== 'check') return 'failed';
  if (r.phase === 'schedule') {
    if (r.status === 'ok') return 'scheduled';
    return r.step === 'unscheduled' && current === 'scheduled' ? 'checked' : null;
  }
  if (r.phase === 'migrate') {
    if (r.step === 'joined' && r.status === 'ok') return 'joined';
    return current === 'joined' ? null : 'migrating';
  }
  if (r.phase === 'postjoin') return r.status === 'done' ? 'completed' : 'joined';
  return null;
}

agentApi.post('/report', async (c) => {
  const device = c.var.device;
  const text = await c.req.text();
  if (text.length > MAX_REPORT_BYTES) return c.json({ error: 'report too large' }, 413);
  let body: ReportBody;
  try {
    body = JSON.parse(text) as ReportBody;
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const phase = String(body.phase ?? 'agent').slice(0, 40);
  const step = body.step ? String(body.step).slice(0, 80) : undefined;
  const detail = body.detail ? String(body.detail).slice(0, 2000) : undefined;

  // Keys the agent read from the device itself: a second copy, independent of Entra ID.
  const keys: BitLockerKeyRecord[] = (body.bitlocker ?? [])
    .filter((k) => typeof k.id === 'string' && typeof k.key === 'string' && /^[\d-]{20,}$/.test(k.key))
    .slice(0, 20)
    .map((k) => ({ id: k.id!, key: k.key!, volumeType: k.volume, createdAt: nowIso(), source: 'agent' as const }));
  if (keys.length) await saveKeys(c.env, device.id, keys);

  const report: DeviceAgentReport = { ...(device.agentReport ?? {}), phase };
  if (body.checks) {
    report.checks = body.checks.slice(0, 40).map((x) => ({
      name: String(x.name).slice(0, 60),
      status: x.status === 'ok' || x.status === 'warn' ? x.status : 'fail',
      detail: x.detail ? String(x.detail).slice(0, 500) : undefined,
    }));
  }
  for (const [k, v] of Object.entries(body.data ?? {})) {
    if (['checks', 'phase'].includes(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') report[k] = v;
  }

  const status = statusForReport(device.status, body);
  await updateDevice(c.env.DB, device.id, {
    agentReport: report,
    ...(status ? { status } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(detail !== undefined || status ? { detail: detail ?? null } : {}),
    // The job is done: the token has nothing left to authorize.
    ...(status === 'completed' ? { agentTokenHash: null, agentTokenExpiresAt: null } : {}),
  });
  await logEvent(c.env.DB, {
    projectId: device.projectId,
    deviceId: device.id,
    level: body.status === 'fail' ? 'error' : body.status === 'warn' ? 'warn' : 'info',
    message: `${device.name} [${phase}${step ? `/${step}` : ''}] ${detail ?? body.status ?? ''}`.trim(),
    data: body.checks ? { checks: report.checks } : undefined,
  });
  return c.json({ ok: true, status: status ?? device.status });
});
