// Shared domain types and Worker environment bindings.

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  MIGRATION_QUEUE: Queue<QueueMessage>;
  ORCHESTRATOR: DurableObjectNamespace;
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** base64-encoded 32-byte AES-256-GCM master key (wrangler secret) */
  ENCRYPTION_KEY: string;
  /** bearer token protecting the API (wrangler secret) */
  API_TOKEN: string;
  /**
   * Optional: Dolop's own multi-tenant Entra app (admin-consent connector
   * mode). When set, connectors can be created by sending a tenant admin a
   * consent link instead of registering an app per tenant.
   */
  MT_CLIENT_ID?: string;
  MT_CLIENT_SECRET?: string;
}

export type Workload = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'drive' | 'rules';

export const ALL_WORKLOADS: Workload[] = ['mail', 'calendar', 'contacts', 'tasks', 'drive', 'rules'];

export type PassType = 'assessment' | 'prestage' | 'full' | 'delta';

export interface PassFilters {
  /** Pre-stage cutoff: only migrate mail received on/before this ISO date. */
  mailReceivedBefore?: string;
  /** Only migrate mail received on/after this ISO date. */
  mailReceivedAfter?: string;
  /** Folder display-name paths to exclude, e.g. "Inbox/Newsletters". Case-insensitive. */
  excludeFolders?: string[];
  excludeDeletedItems?: boolean;
  excludeJunk?: boolean;
  /**
   * 'strip' (default): attendees are removed from migrated events so the destination
   * tenant never sends meeting invitations; the original attendee list is preserved
   * in an open extension (com.dolop.migration) on each event.
   * 'preserve': attendees are kept — Exchange Online may send invitation mail.
   */
  calendarAttendees?: 'strip' | 'preserve';
  /** Drive paths (relative to root, e.g. "Archive/Old") to exclude. Case-insensitive prefix match. */
  driveExcludePaths?: string[];
  /**
   * Full passes only: before creating a message, look it up in the destination
   * by Internet Message-ID and map it instead of duplicating. Use after a
   * migration-state reset so re-runs converge instead of double-copying.
   */
  mailDedupeByMessageId?: boolean;
}

export interface PassConfig {
  passType: PassType;
  workloads: Workload[];
  filters: PassFilters;
}

export interface ProjectSettings {
  /** How many users migrate concurrently (BitTitan-style concurrency control). */
  maxConcurrentUsers: number;
  defaultWorkloads: Workload[];
  /** When true, the cron trigger schedules delta passes for completed users. */
  autoDeltaEnabled?: boolean;
  /** Minimum minutes between automatic delta passes (default 240). */
  autoDeltaIntervalMinutes?: number;
  notes?: string;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  maxConcurrentUsers: 10,
  defaultWorkloads: [...ALL_WORKLOADS],
  autoDeltaEnabled: false,
  autoDeltaIntervalMinutes: 240,
};

export type UserStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'stopped';

/**
 * Mail coexistence direction. The "primary" side (the one that currently owns
 * inbound mail flow / MX) forwards a copy to the counterpart mailbox:
 * - 'src_to_dest': source mailbox forwards to destination (use before cutover).
 * - 'dest_to_src': destination mailbox forwards to source (use after cutover).
 * Only one direction is ever active per user, which prevents forwarding loops.
 */
export type CoexistenceDirection = 'src_to_dest' | 'dest_to_src';

export type CoexistenceStatus = 'off' | 'active' | 'failed';

/** How the forward target address is chosen for coexistence. */
export type CoexistenceForwardMode = 'routing' | 'upn';

export interface WorkloadStats {
  discovered: number;
  migrated: number;
  skipped: number;
  failed: number;
  bytes: number;
  /** Total items known upfront (e.g. mailbox folder item counts) — the real progress denominator. */
  expected?: number;
  /** Total bytes known upfront (e.g. OneDrive quota used). */
  expectedBytes?: number;
}

export function emptyWorkloadStats(): WorkloadStats {
  return { discovered: 0, migrated: 0, skipped: 0, failed: 0, bytes: 0 };
}

/** Per-user stats keyed by workload (plus 'assessment'). */
export type UserStats = Record<string, WorkloadStats>;

/** What a running migration is doing right now. */
export interface UserActivity {
  workload: string;
  phase: string;
  at: string;
}

export interface Connector {
  id: string;
  name: string;
  tenantId: string;
  clientId: string;
  /** decrypted only when needed; never returned by the API */
  clientSecret?: string;
  /**
   * 'secret': per-tenant app registration with its own client secret.
   * 'consent': tenant granted admin consent to this deployment's multi-tenant
   * app (MT_CLIENT_ID/MT_CLIENT_SECRET); no per-connector secret stored.
   */
  authMode: 'secret' | 'consent';
  verifyStatus: 'unverified' | 'ok' | 'failed' | 'pending_consent';
  verifyDetail?: string;
  lastVerifiedAt?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  sourceConnectorId?: string;
  destConnectorId?: string;
  settings: ProjectSettings;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface MigrationUser {
  id: string;
  projectId: string;
  sourceUpn: string;
  destUpn: string;
  sourceId?: string;
  destId?: string;
  displayName?: string;
  status: UserStatus;
  passType?: PassType;
  passConfig?: PassConfig;
  stats: UserStats;
  activity?: UserActivity;
  error?: string;
  heartbeatAt?: string;
  startedAt?: string;
  completedAt?: string;
  /** Mail coexistence (dual-delivery) state for this user. */
  coexistenceStatus: CoexistenceStatus;
  coexistenceDirection?: CoexistenceDirection;
  /** Graph messageRule id of the managed forwarding rule, for clean teardown. */
  coexistenceRuleId?: string;
  /** Address the managed rule forwards to (the counterpart mailbox). */
  coexistenceForwardAddress?: string;
  coexistenceDetail?: string;
  coexistenceUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ItemError {
  id: number;
  projectId: string;
  userId: string;
  workload: string;
  itemType?: string;
  itemId?: string;
  itemName?: string;
  code?: string;
  message?: string;
  createdAt: string;
}

export interface TenantCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

// ---------------------------------------------------------------------------
// Queue messages

export type QueueMessage =
  | {
      type: 'enqueue-users';
      projectId: string;
      userIds: string[];
      pass: PassConfig;
    }
  | {
      type: 'auto-delta';
      projectId: string;
    };

// ---------------------------------------------------------------------------
// Durable Object RPC payloads (sent over fetch)

export interface OrchestratorStartBody {
  projectId: string;
  userId: string;
  pass: PassConfig;
}

export interface CoordinatorEnqueueBody {
  projectId: string;
  maxConcurrent: number;
  users: { userId: string; pass: PassConfig }[];
}
