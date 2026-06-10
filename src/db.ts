// D1 repository layer.

import type {
  Connector,
  ItemError,
  MigrationUser,
  PassConfig,
  Project,
  ProjectSettings,
  UserActivity,
  UserStats,
  UserStatus,
} from './types';
import { DEFAULT_PROJECT_SETTINGS } from './types';
import { newId, nowIso } from './util';

function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Connectors

interface ConnectorRow {
  id: string;
  name: string;
  tenant_id: string;
  client_id: string;
  client_secret_enc: string;
  auth_mode: string;
  verify_status: string;
  verify_detail: string | null;
  last_verified_at: string | null;
  created_at: string;
}

function rowToConnector(r: ConnectorRow): Connector & { clientSecretEnc: string } {
  return {
    id: r.id,
    name: r.name,
    tenantId: r.tenant_id,
    clientId: r.client_id,
    clientSecretEnc: r.client_secret_enc,
    authMode: (r.auth_mode as Connector['authMode']) ?? 'secret',
    verifyStatus: r.verify_status as Connector['verifyStatus'],
    verifyDetail: r.verify_detail ?? undefined,
    lastVerifiedAt: r.last_verified_at ?? undefined,
    createdAt: r.created_at,
  };
}

export async function createConnector(
  db: D1Database,
  data: {
    name: string;
    tenantId: string;
    clientId: string;
    clientSecretEnc: string;
    authMode?: 'secret' | 'consent';
    verifyStatus?: string;
  }
): Promise<string> {
  const id = newId('con');
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO connectors (id, name, tenant_id, client_id, client_secret_enc, auth_mode, verify_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      data.name,
      data.tenantId,
      data.clientId,
      data.clientSecretEnc,
      data.authMode ?? 'secret',
      data.verifyStatus ?? 'unverified',
      now,
      now
    )
    .run();
  return id;
}

/** Bind the tenant granted via admin consent to a pending consent connector. */
export async function bindConsentTenant(
  db: D1Database,
  id: string,
  tenantId: string
): Promise<void> {
  await db
    .prepare(`UPDATE connectors SET tenant_id = ?, verify_status = 'unverified', updated_at = ? WHERE id = ?`)
    .bind(tenantId, nowIso(), id)
    .run();
}

export async function listConnectors(db: D1Database): Promise<Connector[]> {
  const { results } = await db
    .prepare('SELECT * FROM connectors ORDER BY created_at DESC')
    .all<ConnectorRow>();
  return results.map((r) => {
    const { clientSecretEnc: _omit, ...rest } = rowToConnector(r);
    return rest;
  });
}

export async function getConnector(
  db: D1Database,
  id: string
): Promise<(Connector & { clientSecretEnc: string }) | null> {
  const row = await db.prepare('SELECT * FROM connectors WHERE id = ?').bind(id).first<ConnectorRow>();
  return row ? rowToConnector(row) : null;
}

export async function updateConnectorVerify(
  db: D1Database,
  id: string,
  status: 'ok' | 'failed',
  detail: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE connectors SET verify_status = ?, verify_detail = ?, last_verified_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(status, detail, nowIso(), nowIso(), id)
    .run();
}

export async function updateConnectorSecret(
  db: D1Database,
  id: string,
  clientSecretEnc: string
): Promise<void> {
  await db
    .prepare(`UPDATE connectors SET client_secret_enc = ?, verify_status = 'unverified', updated_at = ? WHERE id = ?`)
    .bind(clientSecretEnc, nowIso(), id)
    .run();
}

export async function deleteConnector(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM connectors WHERE id = ?').bind(id).run();
}

// ---------------------------------------------------------------------------
// Projects

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  source_connector_id: string | null;
  dest_connector_id: string | null;
  settings: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    sourceConnectorId: r.source_connector_id ?? undefined,
    destConnectorId: r.dest_connector_id ?? undefined,
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...parseJson<Partial<ProjectSettings>>(r.settings, {}) },
    status: r.status as Project['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createProject(
  db: D1Database,
  data: {
    name: string;
    description?: string;
    sourceConnectorId?: string;
    destConnectorId?: string;
    settings?: Partial<ProjectSettings>;
  }
): Promise<string> {
  const id = newId('prj');
  const now = nowIso();
  const settings = { ...DEFAULT_PROJECT_SETTINGS, ...(data.settings ?? {}) };
  await db
    .prepare(
      `INSERT INTO projects (id, name, description, source_connector_id, dest_connector_id, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      data.name,
      data.description ?? null,
      data.sourceConnectorId ?? null,
      data.destConnectorId ?? null,
      JSON.stringify(settings),
      now,
      now
    )
    .run();
  return id;
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all<ProjectRow>();
  return results.map(rowToProject);
}

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function updateProject(
  db: D1Database,
  id: string,
  patch: {
    name?: string;
    description?: string;
    sourceConnectorId?: string;
    destConnectorId?: string;
    settings?: Partial<ProjectSettings>;
    status?: Project['status'];
  }
): Promise<void> {
  const existing = await getProject(db, id);
  if (!existing) throw new Error('project not found');
  const settings = { ...existing.settings, ...(patch.settings ?? {}) };
  await db
    .prepare(
      `UPDATE projects SET name = ?, description = ?, source_connector_id = ?, dest_connector_id = ?,
       settings = ?, status = ?, updated_at = ? WHERE id = ?`
    )
    .bind(
      patch.name ?? existing.name,
      patch.description ?? existing.description ?? null,
      patch.sourceConnectorId ?? existing.sourceConnectorId ?? null,
      patch.destConnectorId ?? existing.destConnectorId ?? null,
      JSON.stringify(settings),
      patch.status ?? existing.status,
      nowIso(),
      id
    )
    .run();
}

export async function deleteProject(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM item_errors WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM events WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM migration_users WHERE project_id = ?').bind(id),
    db.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
}

// ---------------------------------------------------------------------------
// Migration users

interface UserRow {
  id: string;
  project_id: string;
  source_upn: string;
  dest_upn: string;
  source_id: string | null;
  dest_id: string | null;
  display_name: string | null;
  status: string;
  pass_type: string | null;
  pass_config: string | null;
  stats: string;
  activity: string | null;
  error: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUser(r: UserRow): MigrationUser {
  return {
    id: r.id,
    projectId: r.project_id,
    sourceUpn: r.source_upn,
    destUpn: r.dest_upn,
    sourceId: r.source_id ?? undefined,
    destId: r.dest_id ?? undefined,
    displayName: r.display_name ?? undefined,
    status: r.status as UserStatus,
    passType: (r.pass_type ?? undefined) as MigrationUser['passType'],
    passConfig: parseJson<PassConfig | undefined>(r.pass_config, undefined),
    stats: parseJson<UserStats>(r.stats, {}),
    activity: parseJson<UserActivity | undefined>(r.activity, undefined),
    error: r.error ?? undefined,
    heartbeatAt: r.heartbeat_at ?? undefined,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertUsers(
  db: D1Database,
  projectId: string,
  rows: { sourceUpn: string; destUpn: string; displayName?: string; sourceId?: string }[]
): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const existing = await db
      .prepare('SELECT id FROM migration_users WHERE project_id = ? AND source_upn = ?')
      .bind(projectId, r.sourceUpn.toLowerCase())
      .first<{ id: string }>();
    if (existing) {
      updated++;
      // dest_upn changes are deliberately not applied here: remapping a user's
      // destination must reset their orchestrator state (id map/delta cursors
      // reference the old mailbox), which the API layer handles explicitly.
      stmts.push(
        db
          .prepare(
            `UPDATE migration_users SET display_name = COALESCE(?, display_name),
             source_id = COALESCE(?, source_id), updated_at = ? WHERE id = ?`
          )
          .bind(r.displayName ?? null, r.sourceId ?? null, now, existing.id)
      );
    } else {
      added++;
      stmts.push(
        db
          .prepare(
            `INSERT INTO migration_users (id, project_id, source_upn, dest_upn, display_name, source_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            newId('usr'),
            projectId,
            r.sourceUpn.toLowerCase(),
            r.destUpn.toLowerCase(),
            r.displayName ?? null,
            r.sourceId ?? null,
            now,
            now
          )
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { added, updated };
}

export async function listUsers(
  db: D1Database,
  projectId: string,
  opts: { status?: string; limit?: number; offset?: number } = {}
): Promise<{ users: MigrationUser[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const where = opts.status
    ? 'WHERE project_id = ? AND status = ?'
    : 'WHERE project_id = ?';
  const binds = opts.status ? [projectId, opts.status] : [projectId];
  const [{ results }, count] = await Promise.all([
    db
      .prepare(`SELECT * FROM migration_users ${where} ORDER BY source_upn LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<UserRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM migration_users ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  return { users: results.map(rowToUser), total: count?.n ?? 0 };
}

/** Page through every user in a project (large M&A scopes exceed one page). */
export async function listAllProjectUsers(
  db: D1Database,
  projectId: string,
  max = 10_000
): Promise<MigrationUser[]> {
  const out: MigrationUser[] = [];
  for (let offset = 0; offset < max; offset += 500) {
    const { users, total } = await listUsers(db, projectId, { limit: 500, offset });
    out.push(...users);
    if (out.length >= total || users.length === 0) break;
  }
  return out;
}

export async function getUser(db: D1Database, userId: string): Promise<MigrationUser | null> {
  const row = await db.prepare('SELECT * FROM migration_users WHERE id = ?').bind(userId).first<UserRow>();
  return row ? rowToUser(row) : null;
}

export async function getUsersByIds(db: D1Database, ids: string[]): Promise<MigrationUser[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM migration_users WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<UserRow>();
  return results.map(rowToUser);
}

export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM migration_users WHERE id = ?').bind(userId).run();
}

export async function updateUserStatus(
  db: D1Database,
  userId: string,
  patch: {
    status?: UserStatus;
    passType?: string;
    passConfig?: PassConfig;
    error?: string | null;
    startedAt?: string;
    completedAt?: string | null;
    sourceId?: string;
    destId?: string | null;
    destUpn?: string;
    displayName?: string;
    stats?: UserStats;
    activity?: UserActivity | null;
  }
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const binds: unknown[] = [nowIso()];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    binds.push(patch.status);
  }
  if (patch.passType !== undefined) {
    sets.push('pass_type = ?');
    binds.push(patch.passType);
  }
  if (patch.passConfig !== undefined) {
    sets.push('pass_config = ?');
    binds.push(JSON.stringify(patch.passConfig));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    binds.push(patch.error);
  }
  if (patch.startedAt !== undefined) {
    sets.push('started_at = ?');
    binds.push(patch.startedAt);
  }
  if (patch.completedAt !== undefined) {
    sets.push('completed_at = ?');
    binds.push(patch.completedAt);
  }
  if (patch.sourceId !== undefined) {
    sets.push('source_id = ?');
    binds.push(patch.sourceId);
  }
  if (patch.destId !== undefined) {
    sets.push('dest_id = ?');
    binds.push(patch.destId);
  }
  if (patch.destUpn !== undefined) {
    sets.push('dest_upn = ?');
    binds.push(patch.destUpn.toLowerCase());
  }
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    binds.push(patch.displayName);
  }
  if (patch.stats !== undefined) {
    sets.push('stats = ?');
    binds.push(JSON.stringify(patch.stats));
  }
  if (patch.activity !== undefined) {
    sets.push('activity = ?');
    binds.push(patch.activity ? JSON.stringify(patch.activity) : null);
  }
  binds.push(userId);
  await db.prepare(`UPDATE migration_users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

export async function flushUserProgress(
  db: D1Database,
  userId: string,
  stats: UserStats,
  activity?: UserActivity | null
): Promise<void> {
  await db
    .prepare('UPDATE migration_users SET stats = ?, activity = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(stats), activity ? JSON.stringify(activity) : null, nowIso(), nowIso(), userId)
    .run();
}

export async function projectUserSummary(
  db: D1Database,
  projectId: string
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM migration_users WHERE project_id = ? GROUP BY status')
    .bind(projectId)
    .all<{ status: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.status] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// Item errors & events

export async function insertItemErrors(
  db: D1Database,
  rows: {
    projectId: string;
    userId: string;
    workload: string;
    itemType?: string;
    itemId?: string;
    itemName?: string;
    code?: string;
    message?: string;
  }[]
): Promise<void> {
  if (rows.length === 0) return;
  const now = nowIso();
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO item_errors (project_id, user_id, workload, item_type, item_id, item_name, code, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          r.projectId,
          r.userId,
          r.workload,
          r.itemType ?? null,
          r.itemId ?? null,
          r.itemName ?? null,
          r.code ?? null,
          (r.message ?? '').slice(0, 2000),
          now
        )
    )
  );
}

export async function listItemErrors(
  db: D1Database,
  projectId: string,
  opts: { userId?: string; limit?: number; offset?: number } = {}
): Promise<{ errors: ItemError[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const where = opts.userId ? 'WHERE project_id = ? AND user_id = ?' : 'WHERE project_id = ?';
  const binds = opts.userId ? [projectId, opts.userId] : [projectId];
  const [{ results }, count] = await Promise.all([
    db
      .prepare(`SELECT * FROM item_errors ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM item_errors ${where}`).bind(...binds).first<{ n: number }>(),
  ]);
  return {
    errors: results.map((r) => ({
      id: r.id as number,
      projectId: r.project_id as string,
      userId: r.user_id as string,
      workload: r.workload as string,
      itemType: (r.item_type as string) ?? undefined,
      itemId: (r.item_id as string) ?? undefined,
      itemName: (r.item_name as string) ?? undefined,
      code: (r.code as string) ?? undefined,
      message: (r.message as string) ?? undefined,
      createdAt: r.created_at as string,
    })),
    total: count?.n ?? 0,
  };
}

export async function logEvent(
  db: D1Database,
  data: {
    projectId?: string;
    userId?: string;
    level?: 'info' | 'warn' | 'error';
    message: string;
    data?: unknown;
  }
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO events (project_id, user_id, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(
      data.projectId ?? null,
      data.userId ?? null,
      data.level ?? 'info',
      data.message,
      data.data !== undefined ? JSON.stringify(data.data) : null,
      nowIso()
    )
    .run();
}

export async function listEvents(
  db: D1Database,
  projectId: string,
  opts: { limit?: number } = {}
): Promise<unknown[]> {
  const { results } = await db
    .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .bind(projectId, Math.min(opts.limit ?? 100, 500))
    .all();
  return results;
}
