// GraphClient: token caching, retry policy and timeouts against a fake Graph.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphAuthError, GraphClient, GraphError } from '../src/graph/client';
import { FakeGraph, json } from './support/engine';

class CountingKV {
  readonly data = new Map<string, string>();
  reads = 0;
  async get(key: string, type?: string): Promise<unknown> {
    this.reads++;
    const v = this.data.get(key);
    return v === undefined ? null : type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

let fake: FakeGraph;
let kv: CountingKV;
const client = (clientSecret = 'good', opts?: { timeoutMs?: number }) =>
  new GraphClient({ tenantId: 't1', clientId: 'app', clientSecret }, kv as unknown as KVNamespace, opts);
const tokenRequests = () => fake.log.filter((l) => l.startsWith('POST login.microsoftonline.com')).length;

beforeEach(() => {
  fake = new FakeGraph();
  kv = new CountingKV();
  vi.stubGlobal('fetch', fake.fetch);
  fake
    .route('POST', /^login\.microsoftonline\.com\/t1\/oauth2\/v2\.0\/token$/, (req) =>
      req.body.client_secret === 'good'
        ? json({ access_token: `token-${req.body.client_secret}`, expires_in: 3600 })
        : json({ error: 'invalid_client', error_description: 'bad secret' }, 401)
    )
    .route('GET', /^\/organization$/, () => json({ value: [] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('token cache', () => {
  it('never serves a token cached for a different client secret', async () => {
    await client('good').get('/organization');
    expect(tokenRequests()).toBe(1);
    // A rotated/wrong secret must be checked against Entra, not answered from cache.
    await expect(client('wrong').get('/organization')).rejects.toBeInstanceOf(GraphAuthError);
    expect(tokenRequests()).toBe(2);
    // The right secret still reuses its cached token.
    await client('good').get('/organization');
    expect(tokenRequests()).toBe(2);
  });

  it('keeps the token in memory instead of reading KV on every request', async () => {
    const c = client();
    for (let i = 0; i < 5; i++) await c.get('/organization');
    expect(kv.reads).toBe(1);
    expect(tokenRequests()).toBe(1);
  });
});

describe('retries', () => {
  it('retries an idempotent request once on a 5xx', async () => {
    let calls = 0;
    fake.route('GET', /^\/flaky$/, () => (++calls === 1 ? json({}, 500) : json({ ok: true })));
    await expect(client().get('/flaky')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('never re-sends a POST after a 5xx (it may already have created the item)', async () => {
    let calls = 0;
    fake.route('POST', /^\/users\/u\/messages$/, () => {
      calls++;
      return json({ error: { code: 'InternalServerError', message: 'boom' } }, 500);
    });
    await expect(client().post('/users/u/messages', { subject: 'x' })).rejects.toBeInstanceOf(GraphError);
    expect(calls).toBe(1);
  });
});

describe('timeouts', () => {
  it('aborts a request that hangs', async () => {
    fake.route(
      'GET',
      /^\/hang$/,
      (req) =>
        new Promise<Response>((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(req.signal?.reason));
        })
    );
    await expect(client('good', { timeoutMs: 50 }).get('/hang')).rejects.toThrow(/timed out/);
  });
});
