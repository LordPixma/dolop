// Operator accounts: PBKDF2-SHA256 password hashing (WebCrypto) and
// server-side sessions stored in D1. The session cookie carries a random
// 256-bit token; only its SHA-256 is persisted, so a leaked database cannot
// be replayed into live sessions.

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

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// D1 repositories

export interface Account {
  id: string;
  username: string;
  displayName?: string;
  role: string;
  createdAt: string;
  lastLoginAt?: string;
}

interface AccountRow {
  id: string;
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

export async function listAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT * FROM accounts ORDER BY username').all<AccountRow>();
  return results.map((r) => {
    const { passwordHash: _omit, ...rest } = rowToAccount(r);
    return rest;
  });
}

export async function createAccount(
  db: D1Database,
  data: { username: string; password: string; displayName?: string }
): Promise<string> {
  const id = newId('acc');
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO accounts (id, username, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, data.username.toLowerCase(), data.displayName ?? null, await hashPassword(data.password), now, now)
    .run();
  return id;
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
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
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
  if (!row) return null;
  const { passwordHash: _omit, ...account } = rowToAccount(row);
  return account;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}
