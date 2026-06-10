// MigrationOrchestrator — one Durable Object instance per (project, user).
//
// A migration pass runs as a chain of alarm "ticks". Each tick rebuilds Graph
// clients, runs the current workload engine against a bounded budget, persists
// cursors in the DO's SQLite storage, then flushes stats and item errors to D1
// and re-arms the alarm. Graph throttling (429/503) pauses the chain for the
// advertised retry-after; transient failures retry with exponential backoff;
// auth failures fail the pass with a clear message. The DO can be evicted or
// redeployed at any point — state lives entirely in storage, so the next alarm
// resumes exactly where the previous tick stopped.

import { DurableObject } from 'cloudflare:workers';
import { decryptSecret } from '../crypto';
import {
  flushUserProgress,
  getConnector,
  getProject,
  getUser,
  insertItemErrors,
  logEvent,
  updateUserStatus,
} from '../db';
import { AssessmentEngine } from '../engine/assessment';
import { CalendarEngine } from '../engine/calendar';
import { ContactsEngine } from '../engine/contacts';
import { DriveEngine } from '../engine/drive';
import { MailEngine } from '../engine/mail';
import { RulesEngine } from '../engine/rules';
import { EngineStore } from '../engine/store';
import { TasksEngine } from '../engine/tasks';
import {
  TickBudget,
  userPath,
  type ItemErrorInput,
  type MigrationContext,
  type Reporter,
  type WorkloadEngine,
} from '../engine/workload';
import { GraphAuthError, GraphClient, GraphError, GraphThrottleError } from '../graph/client';
import type { GraphUser } from '../graph/types';
import type {
  Env,
  OrchestratorStartBody,
  PassConfig,
  UserStats,
  Workload,
  WorkloadStats,
} from '../types';
import { ALL_WORKLOADS, emptyWorkloadStats } from '../types';
import { backoffMs, nowIso } from '../util';

interface JobConnector {
  tenantId: string;
  clientId: string;
  secretEnc: string;
  authMode: 'secret' | 'consent';
}

interface JobState {
  projectId: string;
  userId: string;
  pass: PassConfig;
  workloads: (Workload | 'assessment')[];
  workloadIndex: number;
  sourceUpn: string;
  destUpn: string;
  sourceId?: string;
  destId?: string;
  source: JobConnector;
  dest: JobConnector;
}

const TICK_DELAY_MS = 250;
const MAX_TICK_FAILURES = 5;

class StatsReporter implements Reporter {
  errors: ItemErrorInput[] = [];
  errorWorkloads: string[] = [];

  constructor(public stats: UserStats) {}

  private bucket(workload: string): WorkloadStats {
    let b = this.stats[workload];
    if (!b) {
      b = emptyWorkloadStats();
      this.stats[workload] = b;
    }
    return b;
  }

  stat(workload: string, field: 'discovered' | 'migrated' | 'skipped' | 'failed', delta = 1): void {
    this.bucket(workload)[field] += delta;
  }

  bytes(workload: string, n: number): void {
    this.bucket(workload).bytes += n;
  }

  itemError(workload: string, err: ItemErrorInput): void {
    this.errors.push(err);
    this.errorWorkloads.push(workload);
  }
}

const ENGINES: Record<string, WorkloadEngine> = {
  mail: new MailEngine(),
  calendar: new CalendarEngine(),
  contacts: new ContactsEngine(),
  tasks: new TasksEngine(),
  drive: new DriveEngine(),
  rules: new RulesEngine(),
  assessment: new AssessmentEngine(),
};

export class MigrationOrchestrator extends DurableObject<Env> {
  private store: EngineStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new EngineStore(ctx.storage.sql);
    this.store.init();
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case '/start':
          return await this.handleStart((await req.json()) as OrchestratorStartBody);
        case '/stop':
          return await this.handleStop();
        case '/resume':
          return await this.handleResume();
        case '/status':
          return Response.json({
            job: this.store.getJson<JobState>('sys:job'),
            stats: this.store.getJson<UserStats>('sys:stats'),
            done: this.store.getRaw('sys:done') === '1',
          });
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  private async handleStart(body: OrchestratorStartBody): Promise<Response> {
    const { projectId, userId, pass } = body;
    const [user, project] = await Promise.all([
      getUser(this.env.DB, userId),
      getProject(this.env.DB, projectId),
    ]);
    if (!user || !project) {
      return Response.json({ error: 'user or project not found' }, { status: 404 });
    }
    if (!project.sourceConnectorId || !project.destConnectorId) {
      return Response.json({ error: 'project is missing source/destination connectors' }, { status: 400 });
    }
    const [srcCon, dstCon] = await Promise.all([
      getConnector(this.env.DB, project.sourceConnectorId),
      getConnector(this.env.DB, project.destConnectorId),
    ]);
    if (!srcCon || !dstCon) {
      return Response.json({ error: 'connector not found' }, { status: 400 });
    }
    for (const con of [srcCon, dstCon]) {
      if (con.authMode === 'consent' && !con.tenantId) {
        return Response.json(
          { error: `connector ${con.name} is still waiting for admin consent` },
          { status: 400 }
        );
      }
    }

    const workloads: (Workload | 'assessment')[] =
      pass.passType === 'assessment'
        ? ['assessment']
        : ALL_WORKLOADS.filter((w) => pass.workloads.includes(w));
    if (workloads.length === 0) {
      return Response.json({ error: 'no workloads selected' }, { status: 400 });
    }

    // Per-pass state resets; the id map and delta cursors persist so this pass
    // is incremental relative to previous ones.
    this.store.resetPass();
    this.store.delRaw('sys:done');
    this.store.delRaw('sys:stop');
    this.store.delRaw('sys:tickFailures');

    const stats = this.store.getJson<UserStats>('sys:stats') ?? {};
    for (const w of workloads) {
      if (w === 'assessment') {
        for (const k of Object.keys(stats)) if (k.startsWith('assessment')) delete stats[k];
      } else {
        delete stats[w];
      }
    }
    this.store.setJson('sys:stats', stats);

    const job: JobState = {
      projectId,
      userId,
      pass,
      workloads,
      workloadIndex: 0,
      sourceUpn: user.sourceUpn,
      destUpn: user.destUpn,
      sourceId: user.sourceId,
      destId: user.destId,
      source: {
        tenantId: srcCon.tenantId,
        clientId: srcCon.clientId,
        secretEnc: srcCon.clientSecretEnc,
        authMode: srcCon.authMode,
      },
      dest: {
        tenantId: dstCon.tenantId,
        clientId: dstCon.clientId,
        secretEnc: dstCon.clientSecretEnc,
        authMode: dstCon.authMode,
      },
    };
    this.store.setJson('sys:job', job);

    await updateUserStatus(this.env.DB, userId, {
      status: 'running',
      passType: pass.passType,
      passConfig: pass,
      error: null,
      startedAt: nowIso(),
      completedAt: null,
    });
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true });
  }

  private async handleStop(): Promise<Response> {
    this.store.setRaw('sys:stop', '1');
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      // Alarm chain already ended (e.g. a throttle pause lost to eviction) —
      // finalize immediately rather than waiting for an alarm that won't fire.
      if (this.store.getRaw('sys:done') !== '1' && this.store.getJson('sys:job')) {
        await this.finalize('stopped');
      }
    } else {
      // Pull a far-future alarm (throttle backoff) forward so the stop request
      // takes effect promptly.
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }
    return Response.json({ ok: true });
  }

  private async handleResume(): Promise<Response> {
    const job = this.store.getJson<JobState>('sys:job');
    if (!job || this.store.getRaw('sys:done') === '1') {
      // Nothing running here — make sure the coordinator isn't waiting on us.
      if (job) await this.notifyCoordinator(job.projectId, job.userId);
      return Response.json({ ok: true, resumed: false });
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true, resumed: alarm === null });
  }

  override async alarm(): Promise<void> {
    const job = this.store.getJson<JobState>('sys:job');
    if (!job || this.store.getRaw('sys:done') === '1') return;

    if (this.store.getRaw('sys:stop') === '1') {
      await this.finalize('stopped');
      return;
    }

    const reporter = new StatsReporter(this.store.getJson<UserStats>('sys:stats') ?? {});
    try {
      const source = new GraphClient(await this.resolveCreds(job.source), this.env.KV);
      const dest = new GraphClient(await this.resolveCreds(job.dest), this.env.KV);

      if (!job.sourceId) await this.resolveUsers(job, source, dest);

      const workload = job.workloads[job.workloadIndex];
      if (!workload) {
        await this.finishPass(job, reporter);
        return;
      }
      const engine = ENGINES[workload];
      if (!engine) throw new Error(`unknown workload ${workload}`);

      const ctx: MigrationContext = {
        source,
        dest,
        sourceUserPath: userPath(job.sourceId ?? job.sourceUpn),
        destUserPath: userPath(job.destId ?? job.destUpn),
        pass: job.pass,
        store: this.store,
        report: reporter,
        budget: new TickBudget(source, dest),
      };

      const result = await engine.step(ctx);
      this.store.delRaw('sys:tickFailures');

      if (result === 'done') {
        job.workloadIndex++;
        this.store.setJson('sys:job', job);
        if (job.workloadIndex >= job.workloads.length) {
          await this.finishPass(job, reporter);
          return;
        }
      }
      await this.flush(job, reporter);
      await this.ctx.storage.setAlarm(Date.now() + TICK_DELAY_MS);
    } catch (e) {
      await this.flush(job, reporter).catch(() => undefined);
      if (e instanceof GraphThrottleError) {
        const delay = e.retryAfterMs + Math.floor(Math.random() * 2000);
        await this.ctx.storage.setAlarm(Date.now() + delay);
        return;
      }
      if (e instanceof GraphAuthError) {
        await this.finalize('failed', e.message);
        return;
      }
      const failures = parseInt(this.store.getRaw('sys:tickFailures') ?? '0', 10) + 1;
      this.store.setRaw('sys:tickFailures', String(failures));
      const message = e instanceof Error ? e.message : String(e);
      if (failures >= MAX_TICK_FAILURES) {
        await this.finalize('failed', `migration aborted after ${failures} consecutive tick failures: ${message}`);
        return;
      }
      await logEvent(this.env.DB, {
        projectId: job.projectId,
        userId: job.userId,
        level: 'warn',
        message: `tick failed (attempt ${failures}/${MAX_TICK_FAILURES}): ${message}`,
      }).catch(() => undefined);
      await this.ctx.storage.setAlarm(Date.now() + backoffMs(failures, 2000));
    }
  }

  private async resolveCreds(
    con: JobConnector
  ): Promise<{ tenantId: string; clientId: string; clientSecret: string }> {
    if (con.authMode === 'consent') {
      if (!this.env.MT_CLIENT_ID || !this.env.MT_CLIENT_SECRET) {
        throw new GraphAuthError('MT_CLIENT_ID/MT_CLIENT_SECRET secrets are not configured');
      }
      return {
        tenantId: con.tenantId,
        clientId: this.env.MT_CLIENT_ID,
        clientSecret: this.env.MT_CLIENT_SECRET,
      };
    }
    return {
      tenantId: con.tenantId,
      clientId: con.clientId,
      clientSecret: await decryptSecret(con.secretEnc, this.env.ENCRYPTION_KEY),
    };
  }

  private async resolveUsers(job: JobState, source: GraphClient, dest: GraphClient): Promise<void> {
    const src = await source
      .get<GraphUser>(`${userPath(job.sourceUpn)}?$select=id,displayName,userPrincipalName`)
      .catch((e: unknown) => {
        if (e instanceof GraphError && e.status === 404) {
          throw new GraphAuthError(`source user ${job.sourceUpn} not found in source tenant`);
        }
        throw e;
      });
    job.sourceId = src.id;
    let destId: string | undefined;
    const displayName = src.displayName;
    try {
      const dst = await dest.get<GraphUser>(`${userPath(job.destUpn)}?$select=id,displayName`);
      destId = dst.id;
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        if (job.pass.passType !== 'assessment') {
          throw new GraphAuthError(
            `destination user ${job.destUpn} not found — provision it (Users → Provision) before migrating`
          );
        }
        // assessment reports the missing destination itself
      } else {
        throw e;
      }
    }
    job.destId = destId;
    this.store.setJson('sys:job', job);
    await updateUserStatus(this.env.DB, job.userId, {
      sourceId: job.sourceId,
      ...(destId ? { destId } : {}),
      ...(displayName ? { displayName } : {}),
    });
  }

  private async flush(job: JobState, reporter: StatsReporter): Promise<void> {
    this.store.setJson('sys:stats', reporter.stats);
    await flushUserProgress(this.env.DB, job.userId, reporter.stats);
    if (reporter.errors.length > 0) {
      await insertItemErrors(
        this.env.DB,
        reporter.errors.map((err, i) => ({
          projectId: job.projectId,
          userId: job.userId,
          workload: reporter.errorWorkloads[i] ?? 'unknown',
          ...err,
        }))
      );
      reporter.errors = [];
      reporter.errorWorkloads = [];
    }
  }

  private async finishPass(job: JobState, reporter: StatsReporter): Promise<void> {
    await this.flush(job, reporter);
    const stats = this.store.getJson<UserStats>('sys:stats') ?? {};
    const failed = Object.values(stats).reduce((n, s) => n + (s.failed ?? 0), 0);
    await this.finalize(failed > 0 ? 'completed_with_errors' : 'completed');
  }

  private async finalize(
    status: 'completed' | 'completed_with_errors' | 'failed' | 'stopped',
    error?: string
  ): Promise<void> {
    const job = this.store.getJson<JobState>('sys:job');
    this.store.setRaw('sys:done', '1');
    this.store.delRaw('sys:stop');
    await this.ctx.storage.deleteAlarm();
    if (!job) return;
    await updateUserStatus(this.env.DB, job.userId, {
      status,
      error: error ?? null,
      completedAt: nowIso(),
    });
    await logEvent(this.env.DB, {
      projectId: job.projectId,
      userId: job.userId,
      level: status === 'failed' ? 'error' : 'info',
      message: `pass ${job.pass.passType} finished with status ${status}${error ? `: ${error}` : ''}`,
    }).catch(() => undefined);
    await this.notifyCoordinator(job.projectId, job.userId);
  }

  private async notifyCoordinator(projectId: string, userId: string): Promise<void> {
    const stub = this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(projectId));
    await stub
      .fetch('https://do/complete', {
        method: 'POST',
        body: JSON.stringify({ userId }),
        headers: { 'content-type': 'application/json' },
      })
      .catch(() => undefined);
  }
}
