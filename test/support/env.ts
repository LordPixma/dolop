// In-memory Worker environment for API integration tests: D1 backed by
// node:sqlite with the real migrations applied, plus Map-backed KV and
// recording stubs for Queues, R2, Durable Objects and static assets.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env, QueueMessage } from '../../src/types';

// vitest runs from the project root.
const MIGRATIONS_DIR = 'migrations';

function bindable(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) throw new Error('D1_TYPE_ERROR: undefined cannot be bound');
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  get returnsRows(): boolean {
    return /^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }

  allSync<T>(): T[] {
    return this.db.prepare(this.sql).all(...bindable(this.params)).map((r) => ({ ...r }) as T);
  }

  runSync(): { changes: number; last_row_id: number } {
    const r = this.db.prepare(this.sql).run(...bindable(this.params));
    return { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...bindable(this.params));
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return { results: this.allSync<T>(), success: true, meta: {} };
  }

  async run(): Promise<{ results: []; success: true; meta: { changes: number; last_row_id: number } }> {
    return { results: [], success: true, meta: this.runSync() };
  }
}

export class TestD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  /** Atomic like D1: all statements commit together or none do. */
  async batch(stmts: Statement[]): Promise<unknown[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) =>
        s.returnsRows
          ? { results: s.allSync(), success: true, meta: {} }
          : { results: [], success: true, meta: s.runSync() }
      );
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  /** Apply migrations/*.sql in order, optionally stopping before a file. */
  migrate(opts: { before?: string; only?: string } = {}): void {
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (opts.before && file >= opts.before) break;
      if (opts.only && file !== opts.only) continue;
      this.sqlite.exec(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
    }
  }

  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...params).map((r) => ({ ...r }) as T);
  }

  exec(sql: string, ...params: unknown[]): void {
    this.sqlite.prepare(sql).run(...params);
  }
}

class TestKV {
  readonly data = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.data.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/** Durable Object namespace stub: records every fetch, answers {ok:true}. */
class TestDONamespace {
  readonly calls: { name: string; path: string; body: string }[] = [];
  idFromName(name: string): string {
    return name;
  }
  get(name: string) {
    return {
      fetch: async (url: string, init?: { body?: string }) => {
        this.calls.push({ name, path: new URL(url).pathname, body: init?.body ?? '' });
        return Response.json({ ok: true, dequeued: [], signaled: [] });
      },
    };
  }
}

export interface TestEnv {
  env: Env;
  db: TestD1;
  kv: TestKV;
  queue: QueueMessage[];
  orchestrator: TestDONamespace;
  coordinator: TestDONamespace;
}

const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const TEST_API_TOKEN = 'test-api-token';

export function makeEnv(overrides: Partial<Env> = {}, db = new TestD1()): TestEnv {
  if (db.rows("SELECT name FROM sqlite_master WHERE name = 'accounts'").length === 0) db.migrate();
  const kv = new TestKV();
  const queue: QueueMessage[] = [];
  const orchestrator = new TestDONamespace();
  const coordinator = new TestDONamespace();
  const env = {
    DB: db,
    KV: kv,
    R2: { put: async () => undefined },
    MIGRATION_QUEUE: { send: async (m: QueueMessage) => void queue.push(m) },
    ORCHESTRATOR: orchestrator,
    COORDINATOR: coordinator,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ENCRYPTION_KEY: TEST_KEY,
    API_TOKEN: TEST_API_TOKEN,
    ...overrides,
  } as unknown as Env;
  return { env, db, kv, queue, orchestrator, coordinator };
}
