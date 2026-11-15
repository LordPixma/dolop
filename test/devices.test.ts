// Device migration: SID derivation, planning and readiness rules, and the full
// operator + agent API flow against a fake source/destination tenant.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusForReport } from '../src/api/agent';
import { deviceReadiness, entraSidFromObjectId, isReady, suggestPlan, userSid } from '../src/engine/devices';
import worker from '../src/index';
import type { Device } from '../src/types';
import { FakeGraph, json } from './support/engine';
import { makeEnv, TEST_API_TOKEN, type TestEnv } from './support/env';

const ORIGIN = 'https://dolop.test';
const DAY = 86_400_000;
const recent = new Date(Date.now() - 2 * DAY).toISOString();
const DEST_OBJECT_ID = '73d664e4-0886-4a73-b745-c694da45ddb4';
const DEST_SID = 'S-1-12-1-1943430372-1249052806-2496021943-3034400218';
const SRC_OBJECT_ID = '00000001-0002-0003-0405-060708090a0b';

describe('Entra ID SIDs', () => {
  it('derives the profile SID from the object id like Windows does', () => {
    expect(entraSidFromObjectId(DEST_OBJECT_ID)).toBe(DEST_SID);
    expect(entraSidFromObjectId(`{${DEST_OBJECT_ID.toUpperCase()}}`)).toBe(DEST_SID);
    expect(() => entraSidFromObjectId('not-a-guid')).toThrow();
  });

  it('prefers the on-premises SID for synced users', () => {
    expect(userSid({ id: DEST_OBJECT_ID, onPremisesSecurityIdentifier: 'S-1-5-21-1-2-3-1104' })).toBe('S-1-5-21-1-2-3-1104');
    expect(userSid({ id: DEST_OBJECT_ID, onPremisesSecurityIdentifier: null })).toBe(DEST_SID);
  });
});

describe('planning', () => {
  const base = { entraObjectId: 'o', lastActivityAt: recent, inventory: { accountEnabled: true } };
  it('suggests a plan from inventory facts', () => {
    expect(suggestPlan({ ...base, os: 'Windows', trustType: 'AzureAd' })).toBe('migrate');
    expect(suggestPlan({ ...base, os: 'Windows', trustType: 'Workplace' })).toBe('manual');
    expect(suggestPlan({ ...base, os: 'MacMDM', trustType: 'Workplace' })).toBe('manual');
    expect(suggestPlan({ ...base, os: 'Windows', trustType: 'AzureAd', lastActivityAt: '2025-07-20T00:00:00Z' })).toBe('cleanup');
    expect(suggestPlan({ ...base, os: 'Windows', trustType: 'AzureAd', entraObjectId: undefined })).toBe('cleanup');
    expect(suggestPlan({ ...base, os: 'Windows', trustType: 'AzureAd', inventory: { accountEnabled: false } })).toBe('cleanup');
  });

  it('blocks readiness on hybrid devices, missing users and a missing package', () => {
    const device = {
      os: 'Windows', trustType: 'ServerAd', lastActivityAt: recent, bitlockerCount: 0, plan: 'migrate',
    } as Device;
    const checks = deviceReadiness(device, undefined, { packageAvailable: false });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({ platform: 'fail', user: 'fail', package: 'fail', agent_check: 'pending' });
    expect(isReady(checks)).toBe(false);
  });
});

describe('agent report status rules', () => {
  it('moves forward through the migration and never backwards', () => {
    const fail = { status: 'fail' as const };
    expect(statusForReport('agent_issued', { phase: 'check', status: 'done', checks: [] })).toBe('checked');
    expect(statusForReport('agent_issued', { phase: 'check', status: 'done', checks: [{ name: 'x', status: 'fail' }] })).toBe('check_failed');
    expect(statusForReport('migrating', { phase: 'check', status: 'done', checks: [] })).toBeNull();
    expect(statusForReport('checked', { phase: 'schedule', status: 'ok' })).toBe('scheduled');
    expect(statusForReport('scheduled', { phase: 'schedule', step: 'unscheduled', status: 'info' })).toBe('checked');
    expect(statusForReport('scheduled', { phase: 'migrate', step: 'start', status: 'info' })).toBe('migrating');
    expect(statusForReport('migrating', { phase: 'migrate', step: 'joined', status: 'ok' })).toBe('joined');
    expect(statusForReport('joined', { phase: 'migrate', step: 'restart', status: 'info' })).toBeNull();
    expect(statusForReport('joined', { phase: 'postjoin', step: 'done', status: 'done' })).toBe('completed');
    expect(statusForReport('migrating', { phase: 'migrate', ...fail })).toBe('failed');
    expect(statusForReport('completed', { phase: 'migrate', ...fail })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API flow

async function call(t: TestEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${TEST_API_TOKEN}`, ...headers } };
  if (body instanceof ArrayBuffer) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, init) as any, t.env, {} as ExecutionContext);
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: res.status, body: parsed };
}

const agentCall = (t: TestEnv, token: string, method: string, path: string, body?: unknown) =>
  call(t, method, path, body, { authorization: `Bearer ${token}` });

function sourceTenant(fake: FakeGraph) {
  const deleted: string[] = [];
  const id = (n: number) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;
  fake
    .route('GET', /^\/devices$/, () =>
      json({
        value: [
          { id: 'obj-1', deviceId: id(1), displayName: 'LAPTOP-GO-01', operatingSystem: 'Windows', operatingSystemVersion: '10.0.22631', trustType: 'AzureAd', approximateLastSignInDateTime: recent, accountEnabled: true },
          { id: 'obj-2', deviceId: id(2), displayName: 'host01', operatingSystem: 'Windows', trustType: 'Workplace', approximateLastSignInDateTime: recent, accountEnabled: true },
          { id: 'obj-3', deviceId: id(3), displayName: 'LAPTOP-JO-02', operatingSystem: 'Windows', trustType: 'AzureAd', approximateLastSignInDateTime: '2025-07-20T16:00:00Z', accountEnabled: true },
          { id: 'obj-4', deviceId: id(4), displayName: "Samuel's MacBook Pro", operatingSystem: 'MacMDM', trustType: 'Workplace', approximateLastSignInDateTime: recent, accountEnabled: true },
        ],
      })
    )
    .route('GET', /^\/deviceManagement\/managedDevices$/, () =>
      json({
        value: [
          { id: 'md-1', deviceName: 'LAPTOP-GO-01', azureADDeviceId: id(1), userPrincipalName: 'Ada@src.test', serialNumber: 'SER1', lastSyncDateTime: recent, complianceState: 'noncompliant', operatingSystem: 'Windows' },
          { id: 'md-orphan', deviceName: 'HOST01', azureADDeviceId: '00000000-0000-0000-0000-000000000000', lastSyncDateTime: '2025-11-28T14:00:00Z', operatingSystem: 'Windows' },
          { id: 'md-4', deviceName: "Samuel's MacBook Pro", azureADDeviceId: id(4), userPrincipalName: 'sam@src.test', lastSyncDateTime: recent, operatingSystem: 'macOS' },
        ],
      })
    )
    .route('GET', /^\/deviceManagement\/windowsAutopilotDeviceIdentities$/, () => json({ value: [{ id: 'ap-1', serialNumber: 'ser1' }] }))
    .route('GET', /^\/directory\/deviceLocalCredentials$/, () => json({ error: { code: 'Authorization_RequestDenied', message: 'no' } }, 403))
    .route('GET', /^\/devices\/obj-2\/registeredOwners$/, () => json({ value: [{ userPrincipalName: 'sam@src.test' }] }))
    .route('GET', /^\/informationProtection\/bitlocker\/recoveryKeys$/, (req) => {
      expect(req.headers.get('ocp-client-name')).toBe('dolop');
      expect(req.url.searchParams.get('$filter')).toBe(`deviceId eq '${id(1)}'`);
      return json({ value: [{ id: 'k1', volumeType: 'operatingSystemVolume', createdDateTime: recent }] });
    })
    .route('GET', /^\/informationProtection\/bitlocker\/recoveryKeys\/k1$/, () =>
      json({ id: 'k1', key: '111111-222222-333333-444444-555555-666666-777777-888888' })
    )
    .route('GET', /^\/users\/ada%40src\.test$/, () => json({ id: SRC_OBJECT_ID, userPrincipalName: 'ada@src.test' }))
    .route('GET', /^\/users\/ada%40dst\.test$/, () => json({ id: DEST_OBJECT_ID, userPrincipalName: 'ada@dst.test' }))
    .route('DELETE', /^\/(deviceManagement\/windowsAutopilotDeviceIdentities|deviceManagement\/managedDevices|devices)\/([^/]+)$/, (req) => {
      deleted.push(`${req.m[1]}/${req.m[2]}`);
      return new Response(null, { status: 204 });
    });
  return { deleted };
}

describe('device migration API', () => {
  let t: TestEnv;
  let fake: FakeGraph;
  let deleted: string[];
  let projectId: string;

  beforeEach(async () => {
    t = makeEnv({
      ASSETS: {
        fetch: async (req: Request) =>
          new URL(req.url).pathname === '/agent/dolop-agent.ps1'
            ? new Response(readFileSync('public/agent/dolop-agent.ps1', 'utf8'))
            : new Response('not found', { status: 404 }),
      } as unknown as Fetcher,
    });
    fake = new FakeGraph();
    ({ deleted } = sourceTenant(fake));
    vi.stubGlobal('fetch', fake.fetch);

    const connector = async (name: string, tenantId: string) =>
      (await call(t, 'POST', '/api/connectors', { name, tenantId, clientId: 'app', clientSecret: 'secret' })).body.id;
    const src = await connector('Source', '11111111-1111-1111-1111-111111111111');
    const dst = await connector('Destination', '22222222-2222-2222-2222-222222222222');
    const p = await call(t, 'POST', '/api/projects', { name: 'Move', sourceConnectorId: src, destConnectorId: dst });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    projectId = p.body.id;
    await call(t, 'POST', `/api/projects/${projectId}/users`, { mappings: [{ sourceUpn: 'ada@src.test', destUpn: 'ada@dst.test' }] });
  });
  afterEach(() => vi.unstubAllGlobals());

  const devices = async () => (await call(t, 'GET', `/api/projects/${projectId}/devices`)).body.devices as any[];
  const byName = async (name: string) => (await devices()).find((d) => d.name === name);

  async function discover() {
    const r = await call(t, 'POST', `/api/projects/${projectId}/devices/discover`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  }

  it('builds the inventory, pairs users and suggests plans', async () => {
    const r = await discover();
    expect(r).toMatchObject({ found: 5, added: 5 });
    expect(r.warnings.join(' ')).toContain('DeviceLocalCredential.ReadBasic.All');

    const all = await devices();
    const plans = Object.fromEntries(all.map((d) => [d.name, d.plan]));
    expect(plans).toEqual({
      'LAPTOP-GO-01': 'migrate',
      host01: 'manual',
      'LAPTOP-JO-02': 'cleanup',
      "Samuel's MacBook Pro": 'manual',
      HOST01: 'cleanup',
    });
    const go = all.find((d) => d.name === 'LAPTOP-GO-01');
    expect(go).toMatchObject({ autopilotId: 'ap-1', intuneDeviceId: 'md-1', ownerUpn: 'ada@src.test', ready: false });
    expect(go.user).toMatchObject({ sourceUpn: 'ada@src.test', destUpn: 'ada@dst.test' });
    expect(all.find((d) => d.name === 'host01')).toMatchObject({ ownerUpn: 'sam@src.test', user: null });
    expect(all.find((d) => d.name === 'HOST01').sourceKey).toBe('intune:md-orphan');

    // Re-discovery keeps operator overrides and flags devices that disappeared.
    await call(t, 'PATCH', `/api/projects/${projectId}/devices/${go.id}`, { plan: 'ignore' });
    // Every device gone from the source tenant (FakeGraph uses the first matching route).
    fake = new FakeGraph();
    fake.route('GET', /^\/devices$/, () => json({ value: [] }));
    fake.route('GET', /^\/deviceManagement\/managedDevices$/, () => json({ value: [] }));
    sourceTenant(fake);
    vi.stubGlobal('fetch', fake.fetch);
    const again = await discover();
    expect(again).toMatchObject({ found: 0, missing: 5 });
    expect(await byName('LAPTOP-GO-01')).toMatchObject({ plan: 'ignore', planOverridden: true });
    expect((await byName('LAPTOP-JO-02')).missingSince).toBeTruthy();
  });

  it('backs up BitLocker keys encrypted and audits viewing them', async () => {
    await discover();
    const go = await byName('LAPTOP-GO-01');
    const r = await call(t, 'POST', `/api/projects/${projectId}/devices/${go.id}/bitlocker`);
    expect(r.body).toEqual({ count: 1, read: 1 });
    const stored = t.db.rows<{ bitlocker_enc: string }>('SELECT bitlocker_enc FROM devices WHERE id = ?', go.id)[0]!;
    expect(stored.bitlocker_enc).not.toContain('111111');
    const view = await call(t, 'GET', `/api/projects/${projectId}/devices/${go.id}/bitlocker`);
    expect(view.body.keys[0]).toMatchObject({ id: 'k1', key: '111111-222222-333333-444444-555555-666666-777777-888888', source: 'entra' });
    const events = t.db.rows<{ level: string; message: string }>('SELECT level, message FROM events WHERE device_id = ?', go.id);
    expect(events.some((e) => e.level === 'warn' && e.message.includes('viewed'))).toBe(true);
  });

  it('runs the agent flow end to end', async () => {
    await discover();
    const go = await byName('LAPTOP-GO-01');
    const dev = `/api/projects/${projectId}/devices/${go.id}`;

    // No package yet: readiness blocks, but a command can already be created for a check.
    expect(go.readiness.find((c: any) => c.name === 'package').status).toBe('fail');
    const pkgBytes = new TextEncoder().encode('fake ppkg bytes').buffer as ArrayBuffer;
    const bad = await call(t, 'PUT', `/api/projects/${projectId}/devices/package?filename=x.zip`, pkgBytes);
    expect(bad.status).toBe(400);
    const up = await call(t, 'PUT', `/api/projects/${projectId}/devices/package?filename=Dest.ppkg`, pkgBytes);
    expect(up.body.package).toMatchObject({ filename: 'Dest.ppkg', size: 15 });

    await call(t, 'POST', `${dev}/autopilot/remove`);
    expect(deleted).toContain('deviceManagement/windowsAutopilotDeviceIdentities/ap-1');

    const issued = await call(t, 'POST', `${dev}/agent`, {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const token: string = issued.body.token;
    expect(issued.body.commands.check).toContain(token);
    expect(issued.body.commands.check).toContain(`$s = '${ORIGIN}'`);
    expect(t.db.rows('SELECT agent_token_hash FROM devices WHERE id = ?', go.id)[0]).not.toMatchObject({ agent_token_hash: token });

    // The script is public and holds no secrets.
    const script = await call(t, 'GET', '/api/agent/script', undefined, { authorization: '' });
    expect(script.status).toBe(200);
    expect(script.body.text).toContain('dolop device agent');

    expect((await agentCall(t, 'wrong', 'GET', '/api/agent/plan')).status).toBe(401);
    const plan = await agentCall(t, token, 'GET', '/api/agent/plan');
    expect(plan.body).toMatchObject({
      protocol: 1,
      sourceTenantId: '11111111-1111-1111-1111-111111111111',
      destTenantId: '22222222-2222-2222-2222-222222222222',
      sourceUser: { upn: 'ada@src.test', sid: entraSidFromObjectId(SRC_OBJECT_ID) },
      destUser: { upn: 'ada@dst.test', sid: DEST_SID },
      package: { available: true, size: 15 },
    });
    const pkg = await agentCall(t, token, 'GET', '/api/agent/package');
    expect(pkg.body.text).toBe('fake ppkg bytes');

    const report = (body: unknown) => agentCall(t, token, 'POST', '/api/agent/report', body);
    await report({
      phase: 'check', step: 'preflight', status: 'done', detail: 'All checks passed',
      checks: [{ name: 'profile', status: 'ok', detail: 'C:\\Users\\Ada' }],
      data: { profilePath: 'C:\\Users\\Ada', agentVersion: '1.0.0' },
      bitlocker: [{ id: 'P-1', key: '999999-888888-777777-666666-555555-444444-333333-222222' }, { id: 'junk', key: 'not-a-key' }],
    });
    let d = await byName('LAPTOP-GO-01');
    expect(d).toMatchObject({ status: 'checked', ready: true, bitlockerCount: 1 });
    expect(d.agentReport).toMatchObject({ profilePath: 'C:\\Users\\Ada', agentVersion: '1.0.0' });

    await report({ phase: 'schedule', step: 'scheduled', status: 'ok', data: { scheduledFor: '2026-12-01T18:00:00Z' } });
    expect((await byName('LAPTOP-GO-01')).status).toBe('scheduled');
    await report({ phase: 'migrate', step: 'profile', status: 'ok', detail: 'profile list updated' });
    expect((await byName('LAPTOP-GO-01')).status).toBe('migrating');
    await report({ phase: 'migrate', step: 'joined', status: 'ok' });
    await report({ phase: 'migrate', step: 'restart', status: 'info' });
    expect((await byName('LAPTOP-GO-01')).status).toBe('joined');
    await report({ phase: 'postjoin', step: 'done', status: 'done', detail: 'Migration complete.' });
    d = await byName('LAPTOP-GO-01');
    expect(d).toMatchObject({ status: 'completed', step: 'done' });
    // The spent token stops working.
    expect((await agentCall(t, token, 'GET', '/api/agent/plan')).status).toBe(401);

    const detail = await call(t, 'GET', dev);
    expect(detail.body.events.length).toBeGreaterThan(5);

    const clean = await call(t, 'POST', `${dev}/cleanup`, {});
    expect(clean.body.deleted).toEqual(['Intune record', 'Entra ID device']);
    expect(deleted).toEqual(expect.arrayContaining(['deviceManagement/managedDevices/md-1', 'devices/obj-1']));
    expect((await byName('LAPTOP-GO-01')).status).toBe('cleaned_up');
  });

  it('refuses agent commands for unmapped devices and missing destination accounts', async () => {
    await discover();
    const host = await byName('host01');
    await call(t, 'PATCH', `/api/projects/${projectId}/devices/${host.id}`, { plan: 'migrate' });
    const r = await call(t, 'POST', `/api/projects/${projectId}/devices/${host.id}/agent`, {});
    expect(r.status).toBe(400);

    fake.route('GET', /^\/users\/bob%40dst\.test$/, () => json({ error: { code: 'Request_ResourceNotFound', message: 'nope' } }, 404));
    await call(t, 'POST', `/api/projects/${projectId}/users`, { mappings: [{ sourceUpn: 'sam@src.test', destUpn: 'bob@dst.test' }] });
    fake.route('GET', /^\/users\/sam%40src\.test$/, () => json({ id: SRC_OBJECT_ID, userPrincipalName: 'sam@src.test' }));
    const users = (await call(t, 'GET', `/api/projects/${projectId}/users`)).body.users as any[];
    const sam = users.find((u) => u.sourceUpn === 'sam@src.test');
    await call(t, 'PATCH', `/api/projects/${projectId}/devices/${host.id}`, { userId: sam.id });
    const missing = await call(t, 'POST', `/api/projects/${projectId}/devices/${host.id}/agent`, {});
    expect(missing.status).toBe(422);
    expect(missing.body.error).toContain('does not exist in the destination tenant');
  });

  it('only cleans up devices that are done or planned for cleanup', async () => {
    await discover();
    const go = await byName('LAPTOP-GO-01');
    expect((await call(t, 'POST', `/api/projects/${projectId}/devices/${go.id}/cleanup`, {})).status).toBe(409);
    const jo = await byName('LAPTOP-JO-02');
    const r = await call(t, 'POST', `/api/projects/${projectId}/devices/${jo.id}/cleanup`, {});
    expect(r.status).toBe(200);
    expect(deleted).toContain('devices/obj-3');
  });

  it('keeps devices inside their workspace and cleans up with the project', async () => {
    await discover();
    const go = await byName('LAPTOP-GO-01');
    const now = new Date().toISOString();
    t.db.exec('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'ws_other', 'Other', now, now);
    const other = await call(t, 'GET', `/api/projects/${projectId}/devices/${go.id}`, undefined, { 'x-dolop-workspace': 'ws_other' });
    expect(other.status).toBe(404);

    await call(t, 'PUT', `/api/projects/${projectId}/devices/package?filename=a.ppkg`, new TextEncoder().encode('x').buffer as ArrayBuffer);
    expect(t.r2.objects.size).toBe(1);
    const del = await call(t, 'DELETE', `/api/projects/${projectId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(t.db.rows('SELECT id FROM devices')).toEqual([]);
    expect(t.r2.objects.size).toBe(0);
  });
});
