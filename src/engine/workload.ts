// Contracts shared by all workload engines. Engines do incremental work inside
// a budgeted "tick" (one Durable Object alarm), persisting cursors to the DO's
// SQLite store so a migration survives eviction, redeploys and throttling.

import type { GraphClient } from '../graph/client';
import type { PassConfig, Workload } from '../types';
import type { EngineStore } from './store';

/** Caps the work done in a single alarm tick. */
export class TickBudget {
  private items = 0;
  private readonly deadline: number;

  constructor(
    private readonly source: GraphClient,
    private readonly dest: GraphClient,
    private readonly maxSubrequests = 80,
    private readonly maxItems = 25,
    maxMillis = 20_000
  ) {
    this.deadline = Date.now() + maxMillis;
  }

  /** Call after each migrated/processed item. */
  itemDone(): void {
    this.items++;
  }

  get exhausted(): boolean {
    return (
      this.items >= this.maxItems ||
      this.source.requestCount + this.dest.requestCount >= this.maxSubrequests ||
      Date.now() >= this.deadline
    );
  }
}

export interface ItemErrorInput {
  itemType?: string;
  itemId?: string;
  itemName?: string;
  code?: string;
  message?: string;
}

/** Sink for stats and item-level errors; the orchestrator flushes these to D1. */
export interface Reporter {
  stat(workload: string, field: 'discovered' | 'migrated' | 'skipped' | 'failed', delta?: number): void;
  bytes(workload: string, n: number): void;
  /** Register items known upfront — the denominator real progress bars need. */
  expected(workload: string, n: number): void;
  expectedBytes(workload: string, n: number): void;
  itemError(workload: string, err: ItemErrorInput): void;
}

export interface MigrationContext {
  source: GraphClient;
  dest: GraphClient;
  sourceUserPath: string; // "/users/<id-or-upn>"
  destUserPath: string;
  pass: PassConfig;
  store: EngineStore;
  report: Reporter;
  budget: TickBudget;
}

export type StepResult = 'continue' | 'done';

export interface WorkloadEngine {
  readonly name: Workload | 'assessment';
  /**
   * Perform up to one budget's worth of work. Return 'continue' if more work
   * remains (the orchestrator re-arms its alarm), 'done' when the workload is
   * fully migrated for this pass. Throwing GraphThrottleError pauses the tick.
   */
  step(ctx: MigrationContext): Promise<StepResult>;
}

export function userPath(idOrUpn: string): string {
  return `/users/${encodeURIComponent(idOrUpn)}`;
}
