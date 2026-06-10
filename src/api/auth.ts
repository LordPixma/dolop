// Authentication routes. Mounted BEFORE the global auth middleware: login,
// first-run setup and status must be reachable unauthenticated; account
// management routes verify the caller themselves (session or API token).

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  countAccounts,
  createAccount,
  createSession,
  deleteAccount,
  destroySession,
  getAccountById,
  getAccountByUsername,
  getSessionAccount,
  listAccounts,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  setAccountPassword,
  validPassword,
  validUsername,
  verifyPassword,
  type Account,
} from '../accounts';
import { logEvent } from '../db';
import type { Env } from '../types';
import { timingSafeEqual } from '../util';

export const authApi = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const MAX_LOGIN_FAILURES = 10;
const LOCKOUT_SECONDS = 900;

function setSessionCookie(c: Ctx, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

async function callerAccount(c: Ctx): Promise<Account | 'token' | null> {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ') && c.env.API_TOKEN && timingSafeEqual(header.slice(7), c.env.API_TOKEN)) {
    return 'token';
  }
  const cookie = getCookie(c, SESSION_COOKIE) ?? '';
  return getSessionAccount(c.env.DB, cookie);
}

authApi.get('/status', async (c) => {
  const [count, caller] = await Promise.all([countAccounts(c.env.DB), callerAccount(c)]);
  return c.json({
    setupRequired: count === 0,
    authenticated: caller !== null,
    account: caller && caller !== 'token' ? caller : null,
    via: caller === 'token' ? 'token' : caller ? 'session' : null,
  });
});

// First-run: create the initial admin account. Only valid while no accounts exist.
authApi.post('/setup', async (c) => {
  if ((await countAccounts(c.env.DB)) > 0) {
    return c.json({ error: 'setup already completed — sign in instead' }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
    displayName?: string;
  };
  if (!body.username || !validUsername(body.username)) {
    return c.json({ error: 'username must be 3-64 chars (letters, digits, . _ @ -)' }, 400);
  }
  const pwError = validPassword(body.password ?? '');
  if (pwError) return c.json({ error: pwError }, 400);

  const id = await createAccount(c.env.DB, {
    username: body.username,
    password: body.password!,
    displayName: body.displayName,
  });
  const { token } = await createSession(c.env.DB, id, c.req.header('user-agent'));
  setSessionCookie(c, token);
  await logEvent(c.env.DB, { message: `initial admin account created: ${body.username.toLowerCase()}` });
  return c.json({ ok: true, account: { id, username: body.username.toLowerCase() } }, 201);
});

authApi.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = (body.username ?? '').trim().toLowerCase();
  if (!username || !body.password) return c.json({ error: 'username and password are required' }, 400);

  const lockKey = `loginfail:${username}`;
  const failures = parseInt((await c.env.KV.get(lockKey)) ?? '0', 10);
  if (failures >= MAX_LOGIN_FAILURES) {
    return c.json({ error: 'too many failed attempts — try again in 15 minutes' }, 429);
  }

  const account = await getAccountByUsername(c.env.DB, username);
  const ok = account ? await verifyPassword(body.password, account.passwordHash) : false;
  if (!ok || !account) {
    await c.env.KV.put(lockKey, String(failures + 1), { expirationTtl: LOCKOUT_SECONDS });
    return c.json({ error: 'invalid username or password' }, 401);
  }
  await c.env.KV.delete(lockKey);
  const { token } = await createSession(c.env.DB, account.id, c.req.header('user-agent'));
  setSessionCookie(c, token);
  const { passwordHash: _omit, ...safe } = account;
  return c.json({ ok: true, account: safe });
});

authApi.post('/logout', async (c) => {
  const cookie = getCookie(c, SESSION_COOKIE) ?? '';
  await destroySession(c.env.DB, cookie);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

authApi.post('/change-password', async (c) => {
  const caller = await callerAccount(c);
  if (!caller || caller === 'token') {
    return c.json({ error: 'sign in with username/password to change your password' }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    currentPassword?: string;
    newPassword?: string;
  };
  const account = await getAccountById(c.env.DB, caller.id);
  if (!account || !(await verifyPassword(body.currentPassword ?? '', account.passwordHash))) {
    return c.json({ error: 'current password is incorrect' }, 401);
  }
  const pwError = validPassword(body.newPassword ?? '');
  if (pwError) return c.json({ error: pwError }, 400);
  await setAccountPassword(c.env.DB, account.id, body.newPassword!);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team management (any authenticated operator or the API token)

authApi.get('/accounts', async (c) => {
  if (!(await callerAccount(c))) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ accounts: await listAccounts(c.env.DB) });
});

authApi.post('/accounts', async (c) => {
  if (!(await callerAccount(c))) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
    displayName?: string;
  };
  if (!body.username || !validUsername(body.username)) {
    return c.json({ error: 'username must be 3-64 chars (letters, digits, . _ @ -)' }, 400);
  }
  const pwError = validPassword(body.password ?? '');
  if (pwError) return c.json({ error: pwError }, 400);
  if (await getAccountByUsername(c.env.DB, body.username)) {
    return c.json({ error: 'username already exists' }, 409);
  }
  const id = await createAccount(c.env.DB, {
    username: body.username,
    password: body.password!,
    displayName: body.displayName,
  });
  await logEvent(c.env.DB, { message: `operator account created: ${body.username.toLowerCase()}` });
  return c.json({ id }, 201);
});

authApi.post('/accounts/:id/reset-password', async (c) => {
  if (!(await callerAccount(c))) return c.json({ error: 'unauthorized' }, 401);
  const target = await getAccountById(c.env.DB, c.req.param('id'));
  if (!target) return c.json({ error: 'account not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { newPassword?: string };
  const pwError = validPassword(body.newPassword ?? '');
  if (pwError) return c.json({ error: pwError }, 400);
  await setAccountPassword(c.env.DB, target.id, body.newPassword!);
  await logEvent(c.env.DB, { message: `password reset for operator account: ${target.username}` });
  return c.json({ ok: true });
});

authApi.delete('/accounts/:id', async (c) => {
  const caller = await callerAccount(c);
  if (!caller) return c.json({ error: 'unauthorized' }, 401);
  const target = await getAccountById(c.env.DB, c.req.param('id'));
  if (!target) return c.json({ error: 'account not found' }, 404);
  if (caller !== 'token' && caller.id === target.id) {
    return c.json({ error: 'you cannot delete your own account' }, 409);
  }
  if ((await countAccounts(c.env.DB)) <= 1) {
    return c.json({ error: 'cannot delete the last operator account' }, 409);
  }
  await deleteAccount(c.env.DB, target.id);
  await logEvent(c.env.DB, { message: `operator account deleted: ${target.username}` });
  return c.json({ ok: true });
});
