// Device migration, operator API: source-tenant device inventory, readiness,
// BitLocker key backup, Autopilot removal, per-device agent tokens, the
// destination provisioning package, and cleanup of source records.

import { Hono } from 'hono';
import { decryptSecret, encryptSecret } from '../crypto';
import {
  getDevice,
  getDeviceBitLockerEnc,
  getUser,
  listAllProjectUsers,
  listDeviceEvents,
  listDevices,
  logEvent,
  updateDevice,
  updateUserStatus,
  upsertDiscoveredDevices,
} from '../db';
import {
  deleteSourceRecords,
  deviceReadiness,
  discoverDevices,
  fetchBitLockerKeys,
  isReady,
  mergeBitLockerKeys,
  removeFromAutopilot,
  resolveUserSid,
} from '../engine/devices';
import { GraphError } from '../graph/client';
import type { AppEnv, BitLockerKeyRecord, Device, Env, MigrationUser, Project } from '../types';
import { DEVICE_PLANS } from '../types';
import { nowIso } from '../util';
import { ApiError, graphForConnector, loadProject } from './helpers';

export const devicesApi = new Hono<AppEnv>();

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TOKEN_DAYS = 14;

export function packageKey(projectId: string): string {
  return `devices/${projectId}/package.ppkg`;
}

export interface PackageInfo {
  filename: string;
  size: number;
  sha256: string;
  uploadedAt: string;
}

export async function packageInfo(env: Env, projectId: string): Promise<PackageInfo | null> {
  const head = await env.R2.head(packageKey(projectId));
  if (!head) return null;
  return {
    filename: head.customMetadata?.filename ?? 'package.ppkg',
    size: head.size,
    sha256: head.customMetadata?.sha256 ?? '',
    uploadedAt: head.customMetadata?.uploadedAt ?? head.uploaded.toISOString(),
  };
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function errText(e: unknown): string {
  if (e instanceof GraphError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

async function loadDevice(env: Env, project: Project, deviceId: string): Promise<Device> {
  const device = await getDevice(env.DB, deviceId);
  if (!device || device.projectId !== project.id) throw new ApiError(404, 'device not found');
  return device;
}

async function readKeys(env: Env, deviceId: string): Promise<BitLockerKeyRecord[]> {
  const enc = await getDeviceBitLockerEnc(env.DB, deviceId);
  if (!enc) return [];
  return JSON.parse(await decryptSecret(enc, env.ENCRYPTION_KEY)) as BitLockerKeyRecord[];
}

/** Store BitLocker keys (merged with any already saved), encrypted at rest. */
export async function saveKeys(env: Env, deviceId: string, incoming: BitLockerKeyRecord[]): Promise<number> {
  const merged = mergeBitLockerKeys(await readKeys(env, deviceId), incoming);
  await updateDevice(env.DB, deviceId, {
    bitlockerEnc: await encryptSecret(JSON.stringify(merged), env.ENCRYPTION_KEY),
    bitlockerCount: merged.length,
    bitlockerBackedUpAt: nowIso(),
  });
  return merged.length;
}

function view(device: Device, user: MigrationUser | undefined, pkg: boolean) {
  const readiness = device.plan === 'migrate' ? deviceReadiness(device, user, { packageAvailable: pkg }) : [];
  return {
    ...device,
    user: user ? { id: user.id, sourceUpn: user.sourceUpn, destUpn: user.destUpn, status: user.status } : null,
    readiness,
    ready: device.plan === 'migrate' && isReady(readiness),
  };
}

// Inventory, readiness and package state.
devicesApi.get('/:projectId/devices', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const [devices, users, pkg] = await Promise.all([
    listDevices(c.env.DB, project.id),
    listAllProjectUsers(c.env.DB, project.id),
    packageInfo(c.env, project.id),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const summary: Record<string, number> = {};
  for (const d of devices) {
    summary[`plan:${d.plan}`] = (summary[`plan:${d.plan}`] ?? 0) + 1;
    summary[`status:${d.status}`] = (summary[`status:${d.status}`] ?? 0) + 1;
  }
  return c.json({
    devices: devices.map((d) => view(d, d.userId ? byId.get(d.userId) : undefined, Boolean(pkg))),
    summary,
    package: pkg,
  });
});

// Sync the inventory from the source tenant.
devicesApi.post('/:projectId/devices/discover', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const { client } = await graphForConnector(c.env, project, 'source');
  const users = await listAllProjectUsers(c.env.DB, project.id);
  const { rows, warnings } = await discoverDevices(client, users);
  const result = await upsertDiscoveredDevices(c.env.DB, project.id, rows);
  await logEvent(c.env.DB, {
    projectId: project.id,
    message: `device inventory: ${rows.length} found (${result.added} new, ${result.missing} no longer in the source tenant)`,
    data: warnings.length ? { warnings } : undefined,
  });
  return c.json({ ...result, found: rows.length, warnings });
});

devicesApi.get('/:projectId/devices/package', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  return c.json({ package: await packageInfo(c.env, project.id) });
});

// Upload the destination tenant's provisioning package (.ppkg, raw body).
devicesApi.put('/:projectId/devices/package', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) throw new ApiError(400, 'empty upload');
  if (body.byteLength > MAX_PACKAGE_BYTES) throw new ApiError(400, 'package is larger than 20 MB');
  const filename = (c.req.query('filename') ?? 'package.ppkg').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  if (!/\.ppkg$/i.test(filename)) throw new ApiError(400, 'expected a .ppkg file from Windows Configuration Designer');
  const sha256 = await sha256Hex(body);
  const uploadedAt = nowIso();
  await c.env.R2.put(packageKey(project.id), body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { filename, sha256, uploadedAt },
  });
  await logEvent(c.env.DB, {
    projectId: project.id,
    message: `provisioning package uploaded (${filename}, ${body.byteLength} bytes, sha256 ${sha256.slice(0, 12)}…)`,
  });
  return c.json({ package: { filename, size: body.byteLength, sha256, uploadedAt } });
});

devicesApi.delete('/:projectId/devices/package', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  await c.env.R2.delete(packageKey(project.id));
  await logEvent(c.env.DB, { projectId: project.id, message: 'provisioning package deleted' });
  return c.json({ ok: true });
});

// Back up BitLocker keys for many devices (or all with an Entra device id).
devicesApi.post('/:projectId/devices/bitlocker', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const body = (await c.req.json().catch(() => ({}))) as { deviceIds?: string[] };
  const { client } = await graphForConnector(c.env, project, 'source');
  let devices = (await listDevices(c.env.DB, project.id)).filter((d) => d.entraDeviceId && d.plan !== 'ignore');
  if (body.deviceIds?.length) devices = devices.filter((d) => body.deviceIds!.includes(d.id));
  const results: { deviceId: string; name: string; count?: number; error?: string }[] = [];
  for (const d of devices.slice(0, 50)) {
    try {
      const keys = await fetchBitLockerKeys(client, d.entraDeviceId!);
      const count = keys.length ? await saveKeys(c.env, d.id, keys) : d.bitlockerCount;
      results.push({ deviceId: d.id, name: d.name, count });
    } catch (e) {
      const error =
        e instanceof GraphError && e.status === 403
          ? 'the source connector lacks BitLockerKey.Read.All'
          : errText(e);
      results.push({ deviceId: d.id, name: d.name, error });
    }
  }
  await logEvent(c.env.DB, {
    projectId: project.id,
    message: `BitLocker backup: ${results.filter((r) => !r.error).length}/${results.length} device(s) read`,
  });
  return c.json({ results });
});

devicesApi.get('/:projectId/devices/:deviceId', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  const user = device.userId ? ((await getUser(c.env.DB, device.userId)) ?? undefined) : undefined;
  const pkg = await packageInfo(c.env, project.id);
  return c.json({
    device: view(device, user?.projectId === project.id ? user : undefined, Boolean(pkg)),
    events: await listDeviceEvents(c.env.DB, device.id, 100),
  });
});

// Change the plan, the paired user, or mark a manual device done / reset it.
devicesApi.patch('/:projectId/devices/:deviceId', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  const body = (await c.req.json().catch(() => ({}))) as {
    plan?: string;
    userId?: string | null;
    status?: string;
  };
  if (body.plan !== undefined) {
    if (!(DEVICE_PLANS as string[]).includes(body.plan)) {
      throw new ApiError(400, `plan must be one of ${DEVICE_PLANS.join(', ')}`);
    }
    await updateDevice(c.env.DB, device.id, { plan: body.plan as Device['plan'], planOverridden: true });
  }
  if (body.userId !== undefined) {
    if (body.userId !== null) {
      const user = await getUser(c.env.DB, body.userId);
      if (!user || user.projectId !== project.id) throw new ApiError(400, 'user not found in this project');
    }
    // A different user means different profile SIDs: drop the resolved ones
    // and any outstanding agent token.
    await updateDevice(c.env.DB, device.id, {
      userId: body.userId,
      sourceSid: null,
      destSid: null,
      agentTokenHash: null,
      agentTokenExpiresAt: null,
    });
  }
  if (body.status !== undefined) {
    if (body.status !== 'completed' && body.status !== 'discovered') {
      throw new ApiError(400, "status can only be set to 'completed' (done by hand) or 'discovered' (reset)");
    }
    if (device.status === 'migrating' && body.status === 'completed') {
      throw new ApiError(409, 'the agent is migrating this device — wait for it to report');
    }
    await updateDevice(c.env.DB, device.id, { status: body.status, step: null, detail: null });
    await logEvent(c.env.DB, {
      projectId: project.id,
      deviceId: device.id,
      message: body.status === 'completed' ? `${device.name} marked done by hand` : `${device.name} reset`,
    });
  }
  return c.json({ device: await getDevice(c.env.DB, device.id) });
});

devicesApi.post('/:projectId/devices/:deviceId/bitlocker', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  if (!device.entraDeviceId) throw new ApiError(400, 'device has no Entra ID record, so no keys are stored for it');
  const { client } = await graphForConnector(c.env, project, 'source');
  let keys: BitLockerKeyRecord[];
  try {
    keys = await fetchBitLockerKeys(client, device.entraDeviceId);
  } catch (e) {
    if (e instanceof GraphError && e.status === 403) {
      throw new ApiError(422, 'the source connector lacks BitLockerKey.Read.All (add it and grant admin consent again)');
    }
    throw e;
  }
  const count = keys.length ? await saveKeys(c.env, device.id, keys) : device.bitlockerCount;
  await logEvent(c.env.DB, {
    projectId: project.id,
    deviceId: device.id,
    message: `BitLocker: ${keys.length} key(s) read from the source tenant for ${device.name}`,
  });
  return c.json({ count, read: keys.length });
});

// Reveal stored recovery keys (audited).
devicesApi.get('/:projectId/devices/:deviceId/bitlocker', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  const keys = await readKeys(c.env, device.id);
  await logEvent(c.env.DB, {
    projectId: project.id,
    deviceId: device.id,
    level: 'warn',
    message: `BitLocker recovery keys for ${device.name} viewed by ${c.var.account?.username ?? 'API token'}`,
  });
  return c.json({ keys });
});

devicesApi.post('/:projectId/devices/:deviceId/autopilot/remove', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  if (!device.autopilotId) return c.json({ ok: true, detail: 'not registered in Autopilot' });
  const { client } = await graphForConnector(c.env, project, 'source');
  try {
    await removeFromAutopilot(client, device.autopilotId);
  } catch (e) {
    if (e instanceof GraphError && e.status === 403) {
      throw new ApiError(422, 'the source connector lacks DeviceManagementServiceConfig.ReadWrite.All');
    }
    throw e;
  }
  await updateDevice(c.env.DB, device.id, { autopilotId: null });
  await logEvent(c.env.DB, {
    projectId: project.id,
    deviceId: device.id,
    message: `${device.name} removed from the source tenant's Autopilot`,
  });
  return c.json({ ok: true });
});

// Issue (or re-issue) the agent token. Resolves both profile SIDs first, so
// the agent never has to talk to Microsoft Graph itself.
devicesApi.post('/:projectId/devices/:deviceId/agent', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  const body = (await c.req.json().catch(() => ({}))) as { validDays?: number };
  if (device.plan !== 'migrate') throw new ApiError(400, "set the device's plan to Migrate first");
  if (!device.userId) throw new ApiError(400, 'pair the device with a migration user first');
  if (device.status === 'cleaned_up') throw new ApiError(409, 'this device has been cleaned up');
  const user = await getUser(c.env.DB, device.userId);
  if (!user || user.projectId !== project.id) throw new ApiError(400, 'the paired user is no longer in this project');

  const [{ client: src }, { client: dst }] = await Promise.all([
    graphForConnector(c.env, project, 'source'),
    graphForConnector(c.env, project, 'destination'),
  ]);
  let source: { id: string; sid: string };
  let dest: { id: string; sid: string };
  try {
    source = await resolveUserSid(src, user.sourceId ?? user.sourceUpn);
  } catch (e) {
    throw new ApiError(422, `could not look up ${user.sourceUpn} in the source tenant: ${errText(e)}`);
  }
  try {
    dest = await resolveUserSid(dst, user.destUpn);
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) {
      throw new ApiError(422, `${user.destUpn} does not exist in the destination tenant yet — provision it on the Users tab`);
    }
    throw new ApiError(422, `could not look up ${user.destUpn} in the destination tenant: ${errText(e)}`);
  }
  if (!user.destId) await updateUserStatus(c.env.DB, user.id, { destId: dest.id });

  const days = Math.min(30, Math.max(1, Math.floor(body.validDays ?? DEFAULT_TOKEN_DAYS)));
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...tokenBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const keepStatus = ['scheduled', 'migrating', 'joined', 'completed'].includes(device.status);
  await updateDevice(c.env.DB, device.id, {
    sourceSid: source.sid,
    destSid: dest.sid,
    agentTokenHash: await sha256Hex(token),
    agentTokenExpiresAt: expiresAt,
    ...(keepStatus ? {} : { status: 'agent_issued' as const, step: null, detail: null }),
  });
  await logEvent(c.env.DB, {
    projectId: project.id,
    deviceId: device.id,
    message: `agent command created for ${device.name} (valid ${days} days)`,
  });

  const server = new URL(c.req.url).origin;
  const prefix =
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ` +
    `$s = '${server}'; $t = '${token}'; ` +
    `& ([scriptblock]::Create((Invoke-RestMethod "$s/api/agent/script"))) -Server $s -Token $t`;
  return c.json({
    token,
    expiresAt,
    server,
    commands: {
      check: `${prefix} -Mode Check`,
      migrateNow: `${prefix} -Mode Schedule`,
      schedule: `${prefix} -Mode Schedule -At '2026-01-31 18:00'`,
    },
  });
});

devicesApi.delete('/:projectId/devices/:deviceId/agent', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  await updateDevice(c.env.DB, device.id, { agentTokenHash: null, agentTokenExpiresAt: null });
  await logEvent(c.env.DB, { projectId: project.id, deviceId: device.id, message: `agent token revoked for ${device.name}` });
  return c.json({ ok: true });
});

// Delete the device's records from the source tenant.
devicesApi.post('/:projectId/devices/:deviceId/cleanup', async (c) => {
  const project = await loadProject(c.env, c.var.workspaceId, c.req.param('projectId'));
  const device = await loadDevice(c.env, project, c.req.param('deviceId'));
  const body = (await c.req.json().catch(() => ({}))) as { intune?: boolean; entra?: boolean; force?: boolean };
  const allowed = device.status === 'completed' || device.plan === 'cleanup' || body.force === true;
  if (!allowed) {
    throw new ApiError(409, 'only devices that finished migrating or are planned for cleanup can be cleaned up');
  }
  if (device.status === 'migrating' || device.status === 'scheduled') {
    throw new ApiError(409, 'the agent is still working on this device');
  }
  const what = { intune: body.intune !== false, entra: body.entra !== false };
  const { client } = await graphForConnector(c.env, project, 'source');
  let done: string[];
  try {
    done = await deleteSourceRecords(client, device, what);
  } catch (e) {
    if (e instanceof GraphError && e.status === 403) {
      throw new ApiError(
        422,
        'the source connector lacks permission to delete devices (Device.ReadWrite.All for Entra ID, ' +
          'DeviceManagementManagedDevices.ReadWrite.All for Intune)'
      );
    }
    throw e;
  }
  await updateDevice(c.env.DB, device.id, {
    status: 'cleaned_up',
    step: null,
    detail: done.length ? `deleted from source: ${done.join(', ')}` : 'nothing to delete',
    agentTokenHash: null,
    agentTokenExpiresAt: null,
    ...(what.intune ? { intuneDeviceId: null } : {}),
    ...(what.entra ? { entraObjectId: null } : {}),
  });
  await logEvent(c.env.DB, {
    projectId: project.id,
    deviceId: device.id,
    message: `${device.name}: ${done.length ? `deleted ${done.join(' and ')} from the source tenant` : 'no source records to delete'}`,
  });
  return c.json({ ok: true, deleted: done });
});
