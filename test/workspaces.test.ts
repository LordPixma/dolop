// API integration tests for workspaces, self-service registration, invites
// and cross-workspace isolation — run against the real Worker entry point and
// the real D1 migrations (node:sqlite).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { makeEnv, TEST_API_TOKEN, TestD1, type TestEnv } from './support/env';

const ORIGIN = 'https://dolop.test';
const PASSWORD = 'correct-horse-battery';

interface Res {
  status: number;
  body: Record<string, any>;
  headers: Headers;
}

/** A browser-ish client: keeps the session cookie between requests. */
class Client {
  cookie = '';
  constructor(
    private readonly t: TestEnv,
    private readonly headers: Record<string, string> = {}
  ) {}

  async req(method: string, path: string, body?: unknown, raw = false): Promise<Res> {
    const headers: Record<string, string> = { ...this.headers };
    if (this.cookie) headers.cookie = `dolop_session=${this.cookie}`;
    if (body !== undefined) headers['content-type'] = raw ? 'text/plain' : 'application/json';
    const res = await worker.fetch!(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
        redirect: 'manual',
      }) as any,
      this.t.env,
      {} as ExecutionContext
    );
    const match = /dolop_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
    if (match) this.cookie = match[1] ?? '';
    const text = await res.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get = (path: string) => this.req('GET', path);
  post = (path: string, body: unknown = {}) => this.req('POST', path, body);
  patch = (path: string, body: unknown) => this.req('PATCH', path, body);
  del = (path: string) => this.req('DELETE', path);
}

async function setupOwner(t: TestEnv): Promise<Client> {
  const owner = new Client(t);
  const res = await owner.post('/api/auth/setup', {
    username: 'owner',
    password: PASSWORD,
    workspaceName: 'Owner Co',
  });
  expect(res.status).toBe(201);
  return owner;
}

async function signUp(t: TestEnv, username: string, workspaceName: string, ip = '203.0.113.1'): Promise<Client> {
  const client = new Client(t, { 'cf-connecting-ip': ip });
  const res = await client.post('/api/auth/register', { username, password: PASSWORD, workspaceName });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return client;
}

async function addConnector(client: Client, name: string): Promise<string> {
  const res = await client.post('/api/connectors', {
    name,
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientId: 'client',
    clientSecret: 'secret',
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('migration 0006 (workspaces)', () => {
  it('moves pre-existing accounts, connectors and projects into the default workspace', () => {
    const db = new TestD1();
    db.migrate({ before: '0006' });
    const now = new Date().toISOString();
    db.exec(
      `INSERT INTO accounts (id, username, password_hash, created_at, updated_at) VALUES ('acc_1', 'legacy', 'x', ?, ?)`,
      now,
      now
    );
    db.exec(
      `INSERT INTO connectors (id, name, tenant_id, client_id, client_secret_enc, created_at, updated_at)
       VALUES ('con_1', 'c', 't', 'c', '', ?, ?)`,
      now,
      now
    );
    db.exec(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_1', 'p', ?, ?)`, now, now);
    db.migrate({ only: '0006_workspaces.sql' });

    expect(db.rows('SELECT id FROM workspaces')).toEqual([{ id: 'ws_default' }]);
    for (const table of ['accounts', 'connectors', 'projects']) {
      expect(db.rows(`SELECT workspace_id FROM ${table}`)).toEqual([{ workspace_id: 'ws_default' }]);
    }
  });

  it('creates no workspace on a fresh install', () => {
    const db = new TestD1();
    db.migrate();
    expect(db.rows('SELECT id FROM workspaces')).toEqual([]);
  });
});

describe('first-run setup and status', () => {
  it('puts the first admin in the default workspace and reports registration mode', async () => {
    const t = makeEnv();
    const anon = new Client(t);
    let status = await anon.get('/api/auth/status');
    expect(status.body).toMatchObject({ setupRequired: true, registration: 'closed', authenticated: false });

    const owner = await setupOwner(t);
    status = await owner.get('/api/auth/status');
    expect(status.body).toMatchObject({
      setupRequired: false,
      authenticated: true,
      via: 'session',
      workspace: { id: 'ws_default', name: 'Owner Co' },
    });
    expect((await owner.post('/api/auth/setup', { username: 'again', password: PASSWORD })).status).toBe(409);
  });
});

describe('self-service registration', () => {
  it('is refused unless REGISTRATION_MODE=open', async () => {
    const t = makeEnv();
    await setupOwner(t);
    const res = await new Client(t).post('/api/auth/register', {
      username: 'stranger',
      password: PASSWORD,
      workspaceName: 'Stranger Ltd',
    });
    expect(res.status).toBe(403);
  });

  it('waits for first-run setup so the owner claims the default workspace', async () => {
    const t = makeEnv({ REGISTRATION_MODE: 'open' });
    const res = await new Client(t).post('/api/auth/register', {
      username: 'early',
      password: PASSWORD,
      workspaceName: 'Early Bird',
    });
    expect(res.status).toBe(409);
  });

  it('creates a new workspace and signs the user in', async () => {
    const t = makeEnv({ REGISTRATION_MODE: 'open' });
    await setupOwner(t);
    const status = await new Client(t).get('/api/auth/status');
    expect(status.body.registration).toBe('open');

    const user = await signUp(t, 'alice', 'Alice Migrations');
    const me = await user.get('/api/auth/status');
    expect(me.body.authenticated).toBe(true);
    expect(me.body.workspace.name).toBe('Alice Migrations');
    expect(me.body.workspace.id).not.toBe('ws_default');
  });

  it('validates input, rejects taken usernames and rate-limits per IP', async () => {
    const t = makeEnv({ REGISTRATION_MODE: 'open' });
    await setupOwner(t);
    const anon = new Client(t, { 'cf-connecting-ip': '198.51.100.9' });
    expect((await anon.post('/api/auth/register', { username: 'bob', password: PASSWORD })).status).toBe(400);
    expect(
      (await anon.post('/api/auth/register', { username: 'bob', password: 'short', workspaceName: 'Bob' })).status
    ).toBe(400);
    expect(
      (await anon.post('/api/auth/register', { username: 'OWNER', password: PASSWORD, workspaceName: 'Dup' })).status
    ).toBe(409);

    for (let i = 0; i < 5; i++) await signUp(t, `user${i}`, `Workspace ${i}`, '198.51.100.9');
    const blocked = await anon.post('/api/auth/register', { username: 'user5', password: PASSWORD, workspaceName: 'W5' });
    expect(blocked.status).toBe(429);
    await signUp(t, 'user6', 'Other network', '198.51.100.10');
  });
});

describe('workspace isolation', () => {
  let t: TestEnv;
  let owner: Client;
  let alice: Client;
  let ownerConnector: string;
  let ownerProject: string;

  beforeEach(async () => {
    t = makeEnv({ REGISTRATION_MODE: 'open' });
    owner = await setupOwner(t);
    alice = await signUp(t, 'alice', 'Alice Migrations');
    ownerConnector = await addConnector(owner, 'Owner source');
    const res = await owner.post('/api/projects', {
      name: 'Owner project',
      sourceConnectorId: ownerConnector,
      destConnectorId: ownerConnector,
    });
    ownerProject = res.body.id;
  });

  it('hides other workspaces from list endpoints', async () => {
    expect((await alice.get('/api/connectors')).body.connectors).toEqual([]);
    expect((await alice.get('/api/projects')).body.projects).toEqual([]);
    expect((await owner.get('/api/projects')).body.projects).toHaveLength(1);
  });

  it("treats another workspace's project and connector ids as not found", async () => {
    expect((await alice.get(`/api/projects/${ownerProject}`)).status).toBe(404);
    expect((await alice.get(`/api/projects/${ownerProject}/users`)).status).toBe(404);
    expect((await alice.patch(`/api/projects/${ownerProject}`, { name: 'pwned' })).status).toBe(404);
    expect((await alice.del(`/api/projects/${ownerProject}`)).status).toBe(404);
    expect((await alice.post(`/api/projects/${ownerProject}/start`, {})).status).toBe(404);
    expect((await alice.get(`/api/connectors/${ownerConnector}`)).status).toBe(404);
    expect((await alice.post(`/api/connectors/${ownerConnector}/verify`)).status).toBe(404);
    expect((await alice.patch(`/api/connectors/${ownerConnector}`, { clientSecret: 'x' })).status).toBe(404);
    expect((await alice.del(`/api/connectors/${ownerConnector}`)).status).toBe(404);
    // nothing was changed or removed
    expect((await owner.get(`/api/projects/${ownerProject}`)).body.project.name).toBe('Owner project');
    expect((await owner.get(`/api/connectors/${ownerConnector}`)).status).toBe(200);
  });

  it("refuses to attach another workspace's connector to a project", async () => {
    const created = await alice.post('/api/projects', { name: 'Sneaky', sourceConnectorId: ownerConnector });
    expect(created.status).toBe(400);
    const own = await alice.post('/api/projects', { name: 'Mine' });
    expect(own.status).toBe(201);
    const patched = await alice.patch(`/api/projects/${own.body.id}`, { destConnectorId: ownerConnector });
    expect(patched.status).toBe(400);
  });

  it('scopes team management to the workspace', async () => {
    const aliceAccounts = (await alice.get('/api/auth/accounts')).body.accounts;
    expect(aliceAccounts.map((a: { username: string }) => a.username)).toEqual(['alice']);
    const ownerId = (await owner.get('/api/auth/status')).body.account.id;
    expect((await alice.post(`/api/auth/accounts/${ownerId}/reset-password`, { newPassword: PASSWORD })).status).toBe(
      404
    );
    expect((await alice.del(`/api/auth/accounts/${ownerId}`)).status).toBe(404);
    // a directly-added operator lands in the creator's workspace
    expect((await alice.post('/api/auth/accounts', { username: 'alice2', password: PASSWORD })).status).toBe(201);
    expect((await owner.get('/api/auth/accounts')).body.accounts).toHaveLength(1);
  });

  it('only starts users that belong to the project', async () => {
    const aliceProject = (await alice.post('/api/projects', { name: 'Alice project' })).body.id;
    const importRes = await alice.req('POST', `/api/projects/${aliceProject}/users/import`, 'a@src.test,a@dst.test', true);
    expect(importRes.body.added).toBe(1);
    const aliceUserId = (await alice.get(`/api/projects/${aliceProject}/users`)).body.users[0].id;

    await owner.req('POST', `/api/projects/${ownerProject}/users/import`, 'o@src.test,o@dst.test', true);
    const ownerUserId = (await owner.get(`/api/projects/${ownerProject}/users`)).body.users[0].id;

    const start = await owner.post(`/api/projects/${ownerProject}/start`, { userIds: [aliceUserId] });
    expect(start.status).toBe(400);
    expect((await alice.get(`/api/projects/${aliceProject}/users`)).body.users[0].status).toBe('pending');

    const ok = await owner.post(`/api/projects/${ownerProject}/start`, { userIds: [aliceUserId, ownerUserId] });
    expect(ok.body.queued).toBe(1);
    expect(t.queue.flatMap((m) => (m.type === 'enqueue-users' ? m.userIds : []))).toEqual([ownerUserId]);
  });

  it('clamps project settings server-side', async () => {
    await owner.patch(`/api/projects/${ownerProject}`, {
      settings: { maxConcurrentUsers: 100000, autoDeltaIntervalMinutes: 1, defaultWorkloads: ['mail', 'bogus'] },
    });
    const { settings } = (await owner.get(`/api/projects/${ownerProject}`)).body.project;
    expect(settings.maxConcurrentUsers).toBe(100);
    expect(settings.autoDeltaIntervalMinutes).toBe(30);
    expect(settings.defaultWorkloads).toEqual(['mail']);
  });
});

describe('team invites', () => {
  it('lets a new user join the inviting workspace exactly once', async () => {
    const t = makeEnv();
    const owner = await setupOwner(t);
    await owner.post('/api/projects', { name: 'Shared project' });

    const invite = await owner.post('/api/auth/invites', { note: 'for dana' });
    expect(invite.status).toBe(201);
    const token = invite.body.url.split('/#/join/')[1];
    expect(invite.body.url).toBe(`${ORIGIN}/#/join/${token}`);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await owner.get('/api/auth/invites')).body.invites).toMatchObject([{ note: 'for dana', createdBy: 'owner' }]);

    const anon = new Client(t);
    expect((await anon.get(`/api/auth/invites/lookup?token=${token}`)).body).toEqual({
      workspace: { name: 'Owner Co' },
    });

    // works even though self-service registration is closed
    const dana = new Client(t);
    const joined = await dana.post('/api/auth/register', { username: 'dana', password: PASSWORD, inviteToken: token });
    expect(joined.status).toBe(201);
    expect(joined.body.account.workspaceId).toBe('ws_default');
    expect((await dana.get('/api/projects')).body.projects).toHaveLength(1);

    const reuse = await new Client(t).post('/api/auth/register', {
      username: 'eve',
      password: PASSWORD,
      inviteToken: token,
    });
    expect(reuse.status).toBe(400);
    expect((await anon.get(`/api/auth/invites/lookup?token=${token}`)).status).toBe(404);
    expect((await owner.get('/api/auth/invites')).body.invites).toEqual([]);
  });

  it('rejects revoked and expired invites, and cannot be revoked across workspaces', async () => {
    const t = makeEnv({ REGISTRATION_MODE: 'open' });
    const owner = await setupOwner(t);
    const alice = await signUp(t, 'alice', 'Alice Migrations');
    const tokenOf = (url: string) => url.split('/#/join/')[1]!;

    const a = await owner.post('/api/auth/invites', {});
    expect((await alice.del(`/api/auth/invites/${a.body.id}`)).status).toBe(404);
    expect((await owner.del(`/api/auth/invites/${a.body.id}`)).status).toBe(200);
    const revoked = await new Client(t).post('/api/auth/register', {
      username: 'frank',
      password: PASSWORD,
      inviteToken: tokenOf(a.body.url),
    });
    expect(revoked.status).toBe(400);

    const b = await owner.post('/api/auth/invites', {});
    t.db.exec(`UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`, b.body.id);
    const expired = await new Client(t).post('/api/auth/register', {
      username: 'grace',
      password: PASSWORD,
      inviteToken: tokenOf(b.body.url),
    });
    expect(expired.status).toBe(400);
    expect(t.db.rows("SELECT id FROM accounts WHERE username IN ('frank', 'grace')")).toEqual([]);
  });
});

describe('API token', () => {
  it('uses the default workspace unless X-Dolop-Workspace selects one', async () => {
    const t = makeEnv({ REGISTRATION_MODE: 'open' });
    const owner = await setupOwner(t);
    const alice = await signUp(t, 'alice', 'Alice Migrations');
    await owner.post('/api/projects', { name: 'Owner project' });
    await alice.post('/api/projects', { name: 'Alice project' });
    const aliceWs = (await alice.get('/api/auth/status')).body.workspace.id;

    const token = new Client(t, { authorization: `Bearer ${TEST_API_TOKEN}` });
    expect((await token.get('/api/projects')).body.projects.map((p: { name: string }) => p.name)).toEqual([
      'Owner project',
    ]);
    const scoped = new Client(t, { authorization: `Bearer ${TEST_API_TOKEN}`, 'x-dolop-workspace': aliceWs });
    expect((await scoped.get('/api/projects')).body.projects.map((p: { name: string }) => p.name)).toEqual([
      'Alice project',
    ]);
    const unknown = new Client(t, { authorization: `Bearer ${TEST_API_TOKEN}`, 'x-dolop-workspace': 'ws_nope' });
    expect((await unknown.get('/api/projects')).status).toBe(404);
    expect((await new Client(t, { authorization: 'Bearer wrong' }).get('/api/projects')).status).toBe(401);
  });
});

describe('admin consent callback', () => {
  const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const MT = { MT_CLIENT_ID: 'mt-client', MT_CLIENT_SECRET: 'mt-secret' } satisfies Partial<Env>;
  let tokenEndpointTid = TENANT;

  /** Fake Microsoft: the token endpoint issues an id_token for tokenEndpointTid; Graph calls fail. */
  beforeEach(() => {
    tokenEndpointTid = TENANT;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = String(init?.body ?? '');
      if (url.endsWith('/oauth2/v2.0/token') && body.includes('grant_type=authorization_code')) {
        const claims = btoa(JSON.stringify({ aud: 'mt-client', tid: tokenEndpointTid }))
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        return Response.json({ id_token: `e30.${claims}.sig` });
      }
      return Response.json({ error: 'unavailable_in_tests' }, { status: 400 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function consentConnector(client: Client): Promise<{ id: string; state: string }> {
    const res = await client.post('/api/connectors/consent-link', { name: 'Tenant via consent' });
    expect(res.status).toBe(201);
    return { id: res.body.id, state: new URL(res.body.consentUrl).searchParams.get('state')! };
  }

  const tenantOf = (t: TestEnv, id: string) =>
    t.db.rows<{ tenant_id: string }>('SELECT tenant_id FROM connectors WHERE id = ?', id)[0]?.tenant_id;

  it('binds directly on a single-workspace deployment', async () => {
    const t = makeEnv(MT);
    const owner = await setupOwner(t);
    const { id, state } = await consentConnector(owner);
    const res = await owner.get(`/api/consent/callback?admin_consent=True&tenant=${TENANT}&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(tenantOf(t, id)).toBe(TENANT);
  });

  it('requires a Microsoft sign-in at the tenant once registration is open', async () => {
    const t = makeEnv({ ...MT, REGISTRATION_MODE: 'open' });
    await setupOwner(t);
    const alice = await signUp(t, 'alice', 'Alice Migrations');
    const { id, state } = await consentConnector(alice);

    const leg1 = await alice.get(`/api/consent/callback?admin_consent=True&tenant=${TENANT}&state=${encodeURIComponent(state)}`);
    expect(leg1.status).toBe(302);
    expect(tenantOf(t, id)).toBe(''); // nothing bound on the unsigned leg
    const authorize = new URL(leg1.headers.get('location')!);
    expect(authorize.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/consent/callback`);
    const signinState = authorize.searchParams.get('state')!;

    // a sign-in state cannot be replayed as a consent state, and vice versa
    expect(
      (await alice.get(`/api/consent/callback?admin_consent=True&tenant=${TENANT}&state=${encodeURIComponent(signinState)}`)).status
    ).toBe(400);
    expect((await alice.get(`/api/consent/callback?code=abc&state=${encodeURIComponent(state)}`)).status).toBe(400);

    tokenEndpointTid = '99999999-9999-9999-9999-999999999999';
    const wrong = await alice.get(`/api/consent/callback?code=abc&state=${encodeURIComponent(signinState)}`);
    expect(wrong.status).toBe(400);
    expect(wrong.body.text).toContain('Wrong tenant');
    expect(tenantOf(t, id)).toBe('');

    tokenEndpointTid = TENANT;
    const ok = await alice.get(`/api/consent/callback?code=abc&state=${encodeURIComponent(signinState)}`);
    expect(ok.status).toBe(200);
    expect(tenantOf(t, id)).toBe(TENANT);
  });

  it('refuses a tenant already bound by another workspace', async () => {
    const t = makeEnv(MT);
    const owner = await setupOwner(t);
    const first = await consentConnector(owner);
    await owner.get(`/api/consent/callback?admin_consent=True&tenant=${TENANT}&state=${encodeURIComponent(first.state)}`);
    expect(tenantOf(t, first.id)).toBe(TENANT);

    // a second workspace (switch to open mode so registration works)
    t.env.REGISTRATION_MODE = 'open';
    const alice = await signUp(t, 'alice', 'Alice Migrations');
    const second = await consentConnector(alice);
    const leg1 = await alice.get(`/api/consent/callback?admin_consent=True&tenant=${TENANT}&state=${encodeURIComponent(second.state)}`);
    const signinState = new URL(leg1.headers.get('location')!).searchParams.get('state')!;
    const res = await alice.get(`/api/consent/callback?code=abc&state=${encodeURIComponent(signinState)}`);
    expect(res.status).toBe(400);
    expect(res.body.text).toContain('already connected');
    expect(tenantOf(t, second.id)).toBe('');
  });

  it('escapes Microsoft error text on the public page', async () => {
    const t = makeEnv(MT);
    const res = await new Client(t).get(
      `/api/consent/callback?error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}`
    );
    expect(res.status).toBe(400);
    expect(res.body.text).not.toContain('<script>');
    expect(res.body.text).toContain('&#60;script&#62;');
  });
});
