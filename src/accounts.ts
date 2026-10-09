// Operator accounts: PBKDF2-SHA256 password hashing (WebCrypto) and
// server-side sessions stored in D1. The session cookie carries a random
// 256-bit token; only its SHA-256 is persisted, so a leaked database cannot
// be replayed into live sessions. Every account belongs to one workspace —
// the isolation boundary for connectors, projects and team membership.

import { newId, nowIso, timingSafeEqual } from './util';

const PBKDF2_ITERATIONS = 100_000;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_COOKIE = 'dolop_session';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

/** Returns "v1:<iterations>:<salt b64>:<hash b64>". */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `v1:${iterations}:${b64(salt)}:${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, iterStr, saltB64, hashB64] = stored.split(':');
  if (version !== 'v1' || !iterStr || !saltB64 || !hashB64) return false;
  const iterations = parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 5_000_000) return false;
  const hash = await derive(password, b64decode(saltB64), iterations);
  return timingSafeEqual(b64(hash), hashB64);
}

export function validUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9._@-]{2,63}$/i.test(username);
}

export function validPassword(password: string): string | null {
  if (password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 256) return 'password is too long';
  return null;
}

/** Returns the trimmed workspace name, or null if it is unusable. */
export function cleanWorkspaceName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return trimmed.length >= 2 && trimmed.length <= 80 ? trimmed : null;
}

export function registrationOpen(env: { REGISTRATION_MODE?: string }): boolean {
  return (env.REGISTRATION_MODE ?? '').trim().toLowerCase() === 'open';
}

function randomToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// D1 repositories

export interface Account {
  id: string;
  workspaceId: string;
  username: string;
  displayName?: string;
  role: string;
  createdAt: string;
  lastLoginAt?: string;
}

interface AccountRow {
  id: string;
  workspace_id: string | null;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
}

function rowToAccount(r: AccountRow): Account & { passwordHash: string } {
  return {
    id: r.id,
    workspaceId: r.workspace_id ?? '',
    username: r.username,
    displayName: r.display_name ?? undefined,
    passwordHash: r.password_hash,
    role: r.role,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at ?? undefined,
  };
}

export async function countAccounts(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getAccountByUsername(
  db: D1Database,
  username: string
): Promise<(Account & { passwordHash: string }) | null> {
  const row = await db
    .prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first<AccountRow>();
  return row ? rowToAccount(row) : null;
}

export async function getAccountById(
  db: D1Database,
  id: string
): Promise<(Account & { passwordHash: string }) | null> {
  const row = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
  return row ? rowToAccount(row) : null;
}

export async function countWorkspaceAccounts(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listAccounts(db: D1Database, workspaceId: string): Promise<Account[]> {
  const { results } = await db
    .prepare('SELECT * FROM accounts WHERE workspace_id = ? ORDER BY username')
    .bind(workspaceId)
    .all<AccountRow>();
  return results.map((r) => {
    const { passwordHash: _omit, ...rest } = rowToAccount(r);
    return rest;
  });
}

interface NewAccount {
  username: string;
  password: string;
  displayName?: string;
}

function insertAccount(
  db: D1Database,
  id: string,
  workspaceId: string,
  data: NewAccount,
  passwordHash: string
): D1PreparedStatement {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO accounts (id, workspace_id, username, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, workspaceId, data.username.toLowerCase(), data.displayName ?? null, passwordHash, now, now);
}

export async function createAccount(
  db: D1Database,
  data: NewAccount & { workspaceId: string }
): Promise<string> {
  const id = newId('acc');
  await insertAccount(db, id, data.workspaceId, data, await hashPassword(data.password)).run();
  return id;
}

/** Self-service sign-up: a brand-new workspace and its first account, atomically. */
export async function registerWorkspace(
  db: D1Database,
  data: NewAccount & { workspaceName: string }
): Promise<{ accountId: string; workspaceId: string }> {
  const workspaceId = newId('ws');
  const accountId = newId('acc');
  const now = nowIso();
  await db.batch([
    db
      .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(workspaceId, data.workspaceName, now, now),
    insertAccount(db, accountId, workspaceId, data, await hashPassword(data.password)),
  ]);
  return { accountId, workspaceId };
}

/**
 * Register into an existing workspace by redeeming a team invite. The account
 * insert only happens if the invite is unused and unexpired, and the invite is
 * consumed in the same transaction — two concurrent redemptions cannot both
 * succeed. Returns null when the invite is invalid, used or expired.
 */
export async function registerWithInvite(
  db: D1Database,
  data: NewAccount & { inviteToken: string }
): Promise<{ accountId: string; workspaceId: string } | null> {
  const inviteId = await sha256Hex(data.inviteToken);
  const accountId = newId('acc');
  const now = nowIso();
  const passwordHash = await hashPassword(data.password);
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO accounts (id, workspace_id, username, display_name, password_hash, created_at, updated_at)
         SELECT ?, workspace_id, ?, ?, ?, ?, ? FROM invites
         WHERE id = ? AND used_at IS NULL AND expires_at > ?`
      )
      .bind(accountId, data.username.toLowerCase(), data.displayName ?? null, passwordHash, now, now, inviteId, now),
    db
      .prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
      .bind(now, accountId, inviteId, now),
  ]);
  if (!inserted || inserted.meta.changes !== 1) return null;
  const account = await getAccountById(db, accountId);
  return account ? { accountId, workspaceId: account.workspaceId } : null;
}

export async function setAccountPassword(db: D1Database, id: string, password: string): Promise<void> {
  await db
    .prepare('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await hashPassword(password), nowIso(), id)
    .run();
}

export async function deleteAccount(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(id),
  ]);
}

// ---------------------------------------------------------------------------
// Sessions

export async function createSession(
  db: D1Database,
  accountId: string,
  userAgent?: string
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare('INSERT INTO sessions (id, account_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), accountId, nowIso(), expiresAt, (userAgent ?? '').slice(0, 200))
    .run();
  await db
    .prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?')
    .bind(nowIso(), accountId)
    .run();
  // opportunistic cleanup of expired sessions
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()).run();
  return { token, expiresAt };
}

export async function getSessionAccount(db: D1Database, token: string): Promise<Account | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.id = ? AND s.expires_at > ?`
    )
    .bind(await sha256Hex(token), nowIso())
    .first<AccountRow>();
  // An account without a workspace cannot be scoped — treat as signed out.
  if (!row || !row.workspace_id) return null;
  const { passwordHash: _omit, ...account } = rowToAccount(row);
  return account;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}

// ---------------------------------------------------------------------------
// Workspaces

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return { id: r.id, name: r.name, createdAt: r.created_at };
}

export async function getWorkspace(db: D1Database, id: string): Promise<Workspace | null> {
  const row = await db.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first<WorkspaceRow>();
  return row ? rowToWorkspace(row) : null;
}

export async function countWorkspaces(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first<{ n: number }>();
  return row?.n ?? 0;
}

/** Fixed id of the deployment owner's workspace (also used by migration 0006). */
export const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * The deployment owner's workspace, created on demand (idempotent, so
 * concurrent first requests cannot create two). First-run setup and API-token
 * requests without an explicit workspace use it.
 */
export async function ensureDefaultWorkspace(db: D1Database): Promise<Workspace> {
  const existing = await getWorkspace(db, DEFAULT_WORKSPACE_ID);
  if (existing) return existing;
  const now = nowIso();
  await db
    .prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(DEFAULT_WORKSPACE_ID, 'Default workspace', now, now)
    .run();
  const ws = await getWorkspace(db, DEFAULT_WORKSPACE_ID);
  if (!ws) throw new Error('default workspace could not be created');
  return ws;
}

export async function renameWorkspace(db: D1Database, id: string, name: string): Promise<void> {
  await db
    .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, nowIso(), id)
    .run();
}

// ---------------------------------------------------------------------------
// Team invites

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Invite {
  id: string;
  createdBy?: string;
  note?: string;
  createdAt: string;
  expiresAt: string;
}

/** Create a single-use invite; the raw token is returned once and never stored. */
export async function createInvite(
  db: D1Database,
  data: { workspaceId: string; createdBy?: string; note?: string }
): Promise<{ token: string; id: string; expiresAt: string }> {
  const token = randomToken();
  const id = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO invites (id, workspace_id, created_by, note, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, data.workspaceId, data.createdBy ?? null, data.note ?? null, nowIso(), expiresAt)
    .run();
  return { token, id, expiresAt };
}

/** Pending (unused, unexpired) invites for a workspace. */
export async function listInvites(db: D1Database, workspaceId: string): Promise<Invite[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.note, i.created_at, i.expires_at, a.username AS created_by
       FROM invites i LEFT JOIN accounts a ON a.id = i.created_by
       WHERE i.workspace_id = ? AND i.used_at IS NULL AND i.expires_at > ?
       ORDER BY i.created_at DESC`
    )
    .bind(workspaceId, nowIso())
    .all<{ id: string; note: string | null; created_at: string; expires_at: string; created_by: string | null }>();
  return results.map((r) => ({
    id: r.id,
    createdBy: r.created_by ?? undefined,
    note: r.note ?? undefined,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/** Returns true if a pending invite in this workspace was revoked. */
export async function revokeInvite(db: D1Database, workspaceId: string, id: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM invites WHERE id = ? AND workspace_id = ? AND used_at IS NULL')
    .bind(id, workspaceId)
    .run();
  return res.meta.changes > 0;
}

/** Resolve a still-redeemable invite token to its workspace (for the join page). */
export async function lookupInvite(db: D1Database, token: string): Promise<Workspace | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT w.* FROM invites i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.id = ? AND i.used_at IS NULL AND i.expires_at > ?`
    )
    .bind(await sha256Hex(token), nowIso())
    .first<WorkspaceRow>();
  return row ? rowToWorkspace(row) : null;
}
