// Engine test harness: the real EngineStore over node:sqlite (standing in for
// Durable Object SQLite storage) and the real GraphClient talking to an
// in-memory fake of the Graph endpoints under test, reached through a stubbed
// global fetch. Ticks and pass resets mirror what MigrationOrchestrator does.

import { DatabaseSync } from 'node:sqlite';
import { EngineStore } from '../../src/engine/store';
import {
  TickBudget,
  type ItemErrorInput,
  type MigrationContext,
  type Reporter,
  type StepResult,
  type WorkloadEngine,
} from '../../src/engine/workload';
import { GraphClient, GraphThrottleError } from '../../src/graph/client';
import type { PassConfig, UserStats, WorkloadStats } from '../../src/types';
import { emptyWorkloadStats } from '../../src/types';

/** Durable Object SqlStorage subset used by EngineStore, backed by node:sqlite. */
export function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings).map((r) => ({ ...r }));
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
  /** Raw request body (chunk uploads). */
  raw: ArrayBuffer | null;
  /** Regex capture groups from the matched route. */
  m: RegExpMatchArray;
  signal?: AbortSignal;
}

type Handler = (req: FakeRequest) => Response | Promise<Response>;

export const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/**
 * A routed fake of Microsoft Graph (plus token, download and upload-session
 * hosts). Routes match against "<host><path>" so e.g. /users/src/contacts and
 * https://upload.test/s1 can both be registered.
 */
export class FakeGraph {
  private routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  private failures: { method: string; pattern: RegExp; times: number; after: number; status: number }[] = [];
  readonly log: string[] = [];

  route(method: string, pattern: RegExp, handler: Handler): this {
    this.routes.push({ method, pattern, handler });
    return this;
  }

  /** After letting `after` matching requests through, answer the next `times` with 429. */
  throttle(method: string, pattern: RegExp, opts: { times?: number; after?: number } = {}): void {
    this.fail(method, pattern, { ...opts, status: 429 });
  }

  /** After letting `after` matching requests through, answer the next `times` with an error status. */
  fail(method: string, pattern: RegExp, opts: { times?: number; after?: number; status?: number } = {}): void {
    this.failures.push({ method, pattern, times: opts.times ?? 1, after: opts.after ?? 0, status: opts.status ?? 500 });
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    // Graph paths are matched without the /v1.0 prefix.
    const target = url.host === 'graph.microsoft.com' ? url.pathname.replace(/^\/v1\.0/, '') : `${url.host}${url.pathname}`;
    this.log.push(`${method} ${target}`);

    const failure = this.failures.find((f) => f.times > 0 && f.method === method && f.pattern.test(target));
    if (failure && failure.after > 0) {
      failure.after--;
    } else if (failure) {
      failure.times--;
      if (failure.status === 429) return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
      return json({ error: { code: `Injected${failure.status}`, message: 'injected failure' } }, failure.status);
    }
    for (const r of this.routes) {
      const m = r.method === method ? target.match(r.pattern) : null;
      if (!m) continue;
      let raw: ArrayBuffer | null = null;
      let body: unknown;
      if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
        raw = init.body instanceof Uint8Array ? init.body.slice().buffer : init.body;
      } else if (init.body instanceof URLSearchParams) {
        body = Object.fromEntries(init.body);
      } else if (typeof init.body === 'string') {
        body = JSON.parse(init.body);
      }
      return r.handler({ method, url, headers: new Headers(init.headers), body, raw, m, signal: init.signal ?? undefined });
    }
    if (url.host === 'login.microsoftonline.com') {
      return json({ access_token: 'token', expires_in: 3600 });
    }
    return json({ error: { code: 'itemNotFound', message: `no fake route for ${method} ${target}` } }, 404);
  };
}

/**
 * Serve one page of `items` the way Graph does: page size from the
 * `odata.maxpagesize` preference, position in a `$skiptoken`, and either a
 * nextLink or — for delta feeds — a deltaLink on the last page.
 */
export function pageOf<T>(items: T[], req: FakeRequest, opts: { delta?: boolean } = {}): Response {
  const prefer = req.headers.get('prefer') ?? '';
  const size = parseInt(/odata\.maxpagesize=(\d+)/.exec(prefer)?.[1] ?? '', 10) || items.length || 1;
  if (req.url.searchParams.has('$deltatoken')) return json({ value: [], '@odata.deltaLink': req.url.toString() });
  const start = parseInt(req.url.searchParams.get('$skiptoken') ?? '0', 10);
  const end = start + size;
  const body: Record<string, unknown> = { value: items.slice(start, end) };
  const link = new URL(req.url.toString());
  if (end < items.length) {
    link.searchParams.set('$skiptoken', String(end));
    body['@odata.nextLink'] = link.toString();
  } else if (opts.delta) {
    link.searchParams.delete('$skiptoken');
    link.searchParams.set('$deltatoken', 'latest');
    body['@odata.deltaLink'] = link.toString();
  }
  return json(body);
}

class TestReporter implements Reporter {
  constructor(
    public stats: UserStats,
    public errors: ItemErrorInput[]
  ) {}
  private bucket(w: string): WorkloadStats {
    return (this.stats[w] ??= emptyWorkloadStats());
  }
  stat(w: string, field: 'discovered' | 'migrated' | 'skipped' | 'failed', delta = 1): void {
    this.bucket(w)[field] += delta;
  }
  bytes(w: string, n: number): void {
    this.bucket(w).bytes += n;
  }
  expected(w: string, n: number): void {
    const b = this.bucket(w);
    b.expected = (b.expected ?? 0) + n;
  }
  expectedBytes(w: string, n: number): void {
    const b = this.bucket(w);
    b.expectedBytes = (b.expectedBytes ?? 0) + n;
  }
  itemError(_w: string, err: ItemErrorInput): void {
    this.errors.push(err);
  }
}

class MemoryKV {
  private data = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
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

export type TickOutcome = StepResult | 'throttled';

/** Runs an engine tick by tick against one user's store, like the orchestrator. */
export class EngineHarness {
  readonly store = new EngineStore(sqlStorage());
  stats: UserStats = {};
  errors: ItemErrorInput[] = [];
  private readonly kv = new MemoryKV() as unknown as KVNamespace;

  constructor(
    private pass: PassConfig,
    private readonly budget: { maxSubrequests?: number; maxItems?: number } = {}
  ) {
    this.store.init();
  }

  /** Start a new pass: what MigrationOrchestrator does on /start. */
  newPass(pass: PassConfig = this.pass): void {
    this.pass = pass;
    this.store.resetPass();
    this.stats = {};
    this.errors = [];
  }

  async tick(engine: WorkloadEngine): Promise<TickOutcome> {
    // Fresh clients per tick, exactly as the orchestrator builds them.
    const source = new GraphClient({ tenantId: 'src-tenant', clientId: 'app', clientSecret: 's' }, this.kv);
    const dest = new GraphClient({ tenantId: 'dst-tenant', clientId: 'app', clientSecret: 's' }, this.kv);
    const ctx: MigrationContext = {
      source,
      dest,
      sourceUserPath: '/users/src',
      destUserPath: '/users/dst',
      pass: this.pass,
      store: this.store,
      report: new TestReporter(this.stats, this.errors),
      budget: new TickBudget(source, dest, this.budget.maxSubrequests, this.budget.maxItems),
    };
    try {
      return await engine.step(ctx);
    } catch (e) {
      if (e instanceof GraphThrottleError) return 'throttled';
      throw e;
    }
  }

  /** Tick until the engine reports 'done' (or `until` returns true); returns the tick count. */
  async run(engine: WorkloadEngine, opts: { until?: () => boolean; maxTicks?: number } = {}): Promise<number> {
    const maxTicks = opts.maxTicks ?? 1000;
    for (let i = 1; i <= maxTicks; i++) {
      if ((await this.tick(engine)) === 'done') return i;
      if (opts.until?.()) return i;
    }
    throw new Error(`engine did not finish within ${maxTicks} ticks`);
  }
}

export const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** Count occurrences of each value. */
export function tally(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}
