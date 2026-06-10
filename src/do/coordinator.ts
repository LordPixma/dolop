// ProjectCoordinator — one Durable Object per project. Implements the
// concurrent-migration limit: queued users are admitted to their
// MigrationOrchestrator as running slots free up. Orchestrators call
// /complete when a pass finishes (any terminal status), which admits the
// next queued user.

import { DurableObject } from 'cloudflare:workers';
import { updateUserStatus } from '../db';
import type { CoordinatorEnqueueBody, Env, PassConfig } from '../types';

interface QueueEntry {
  userId: string;
  pass: PassConfig;
}

export class ProjectCoordinator extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS queue (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id TEXT NOT NULL UNIQUE,
         pass TEXT NOT NULL
       )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS running (user_id TEXT PRIMARY KEY, started_at TEXT NOT NULL)`
    );
  }

  private kvGet(k: string): string | null {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray();
    return rows[0]?.v ?? null;
  }

  private kvSet(k: string, v: string): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case '/enqueue':
          return await this.handleEnqueue((await req.json()) as CoordinatorEnqueueBody);
        case '/complete': {
          const { userId } = (await req.json()) as { userId: string };
          this.sql.exec('DELETE FROM running WHERE user_id = ?', userId);
          await this.admit();
          return Response.json({ ok: true });
        }
        case '/stop':
          return await this.handleStop((await req.json()) as { userIds?: string[] });
        case '/status':
          return Response.json(this.statusSnapshot());
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  private statusSnapshot() {
    const queued = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM queue').toArray()[0]?.n ?? 0;
    const running = this.sql
      .exec<{ user_id: string; started_at: string }>('SELECT user_id, started_at FROM running')
      .toArray();
    return {
      queued,
      running: running.map((r) => ({ userId: r.user_id, startedAt: r.started_at })),
      maxConcurrent: parseInt(this.kvGet('maxConcurrent') ?? '10', 10),
    };
  }

  private async handleEnqueue(body: CoordinatorEnqueueBody): Promise<Response> {
    this.kvSet('projectId', body.projectId);
    this.kvSet('maxConcurrent', String(Math.max(1, body.maxConcurrent)));
    for (const u of body.users) {
      const isRunning =
        (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM running WHERE user_id = ?', u.userId).toArray()[0]
          ?.n ?? 0) > 0;
      if (isRunning) continue;
      this.sql.exec(
        `INSERT INTO queue (user_id, pass) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET pass = excluded.pass`,
        u.userId,
        JSON.stringify(u.pass)
      );
    }
    await this.admit();
    return Response.json({ ok: true, ...this.statusSnapshot() });
  }

  private async handleStop(body: { userIds?: string[] }): Promise<Response> {
    const target = body.userIds ? new Set(body.userIds) : null;

    const queuedRows = this.sql
      .exec<{ user_id: string }>('SELECT user_id FROM queue')
      .toArray()
      .map((r) => r.user_id)
      .filter((id) => !target || target.has(id));
    for (const id of queuedRows) {
      this.sql.exec('DELETE FROM queue WHERE user_id = ?', id);
      await updateUserStatus(this.env.DB, id, { status: 'stopped' }).catch(() => undefined);
    }

    const projectId = this.kvGet('projectId') ?? '';
    const runningRows = this.sql
      .exec<{ user_id: string }>('SELECT user_id FROM running')
      .toArray()
      .map((r) => r.user_id)
      .filter((id) => !target || target.has(id));
    for (const id of runningRows) {
      const stub = this.env.ORCHESTRATOR.get(this.env.ORCHESTRATOR.idFromName(`${projectId}/${id}`));
      await stub
        .fetch('https://do/stop', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
        .catch(() => undefined);
    }
    return Response.json({ ok: true, dequeued: queuedRows, signaled: runningRows });
  }

  private async admit(): Promise<void> {
    const projectId = this.kvGet('projectId');
    if (!projectId) return;
    const max = parseInt(this.kvGet('maxConcurrent') ?? '10', 10);

    for (;;) {
      const runningCount =
        this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM running').toArray()[0]?.n ?? 0;
      if (runningCount >= max) return;
      const next = this.sql
        .exec<{ seq: number; user_id: string; pass: string }>(
          'SELECT seq, user_id, pass FROM queue ORDER BY seq LIMIT 1'
        )
        .toArray()[0];
      if (!next) return;
      this.sql.exec('DELETE FROM queue WHERE seq = ?', next.seq);
      this.sql.exec(
        'INSERT OR REPLACE INTO running (user_id, started_at) VALUES (?, ?)',
        next.user_id,
        new Date().toISOString()
      );

      const entry: QueueEntry = { userId: next.user_id, pass: JSON.parse(next.pass) as PassConfig };
      const stub = this.env.ORCHESTRATOR.get(this.env.ORCHESTRATOR.idFromName(`${projectId}/${entry.userId}`));
      try {
        const res = await stub.fetch('https://do/start', {
          method: 'POST',
          body: JSON.stringify({ projectId, userId: entry.userId, pass: entry.pass }),
          headers: { 'content-type': 'application/json' },
        });
        if (!res.ok) {
          const detail = ((await res.json().catch(() => ({}))) as { error?: string }).error;
          throw new Error(detail ?? `orchestrator start failed (HTTP ${res.status})`);
        }
      } catch (e) {
        this.sql.exec('DELETE FROM running WHERE user_id = ?', entry.userId);
        await updateUserStatus(this.env.DB, entry.userId, {
          status: 'failed',
          error: `failed to start: ${e instanceof Error ? e.message : String(e)}`,
        }).catch(() => undefined);
      }
    }
  }
}
