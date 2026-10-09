// Authentication routes. Mounted BEFORE the global auth middleware: login,
// first-run setup, registration, invite lookup and status must be reachable
// unauthenticated; account, team and workspace management routes verify the
// caller themselves (session or API token) and act only on the caller's
// workspace.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  cleanWorkspaceName,
  countAccounts,
  countWorkspaceAccounts,
  createAccount,
  createInvite,
  createSession,
  deleteAccount,
  destroySession,
  ensureDefaultWorkspace,
  getAccountById,
  getAccountByUsername,
  getWorkspace,
  INVITE_TTL_SECONDS,
  listAccounts,
  listInvites,
  lookupInvite,
  registerWithInvite,
  registerWorkspace,
  registrationOpen,
  renameWorkspace,
  revokeInvite,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  setAccountPassword,
  validPassword,
  validUsername,
  verifyPassword,
} from '../accounts';
import { resolveCaller, type Caller } from '../auth';
import { logEvent } from '../db';
import type { AppEnv } from '../types';
import { ApiError } from './helpers';

export const authApi = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const MAX_LOGIN_FAILURES = 10;
const LOCKOUT_SECONDS = 900;
/** Self-service sign-ups allowed per client IP per hour (abuse brake). */
const MAX_REGISTRATIONS_PER_HOUR = 5;

const USERNAME_RULES = 'username must be 3-64 chars (letters, digits, . _ @ -)';

function setSessionCookie(c: Ctx, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** The authenticated caller, or a 401/404 ApiError. */
async function requireCaller(c: Ctx): Promise<Caller> {
  const caller = await resolveCaller(c);
  if (caller === 'unknown-workspace') throw new ApiError(404, 'workspace not found');
  if (!caller) throw new ApiError(401, 'unauthorized');
  return caller;
}

interface CredentialsBody {
  username?: string;
  password?: string;
  displayName?: string;
}

/** Validate username/password for a new account; returns the normalized fields. */
function newAccountFields(body: CredentialsBody): { username: string; password: string; displayName?: string } {
  const username = (body.username ?? '').trim();
  if (!validUsername(username)) throw new ApiError(400, USERNAME_RULES);
  const pwError = validPassword(body.password ?? '');
  if (pwError) throw new ApiError(400, pwError);
  const displayName = body.displayName?.trim().slice(0, 120) || undefined;
  return { username, password: body.password!, displayName };
}

async function assertUsernameFree(c: Ctx, username: string): Promise<void> {
  if (await getAccountByUsername(c.env.DB, username)) {
    throw new ApiError(409, 'that username is already taken');
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

authApi.get('/status', async (c) => {
  const [count, caller] = await Promise.all([countAccounts(c.env.DB), resolveCaller(c)]);
  const signedIn = caller && caller !== 'unknown-workspace' ? caller : null;
  const workspace = signedIn ? await getWorkspace(c.env.DB, signedIn.workspaceId) : null;
  return c.json({
    setupRequired: count === 0,
    registration: registrationOpen(c.env) ? 'open' : 'closed',
    authenticated: signedIn !== null,
    account: signedIn?.account ?? null,
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    via: signedIn?.via ?? null,
  });
});

// First-run: create the initial admin account in the deployment's default
// workspace. Only valid while no accounts exist anywhere.
authApi.post('/setup', async (c) => {
  if ((await countAccounts(c.env.DB)) > 0) {
    return c.json({ error: 'setup already completed — sign in instead' }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as CredentialsBody & { workspaceName?: string };
  const fields = newAccountFields(body);
  const workspace = await ensureDefaultWorkspace(c.env.DB);
  const workspaceName = cleanWorkspaceName(body.workspaceName);
  if (workspaceName) await renameWorkspace(c.env.DB, workspace.id, workspaceName);

  const id = await createAccount(c.env.DB, { ...fields, workspaceId: workspace.id });
  const { token } = await createSession(c.env.DB, id, c.req.header('user-agent'));
  setSessionCookie(c, token);
  await logEvent(c.env.DB, { message: `initial admin account created: ${fields.username.toLowerCase()}` });
  return c.json({ ok: true, account: { id, username: fields.username.toLowerCase() } }, 201);
});

// Registration. With an invite token: join the inviting workspace (always
// allowed — an existing operator vouched for this person). Without one:
// self-service sign-up into a brand-new, isolated workspace, only when the
// deployment sets REGISTRATION_MODE=open.
authApi.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CredentialsBody & {
    workspaceName?: string;
    inviteToken?: string;
  };
  const fields = newAccountFields(body);
  const inviteToken = (body.inviteToken ?? '').trim();

  let result: { accountId: string; workspaceId: string } | null;
  if (inviteToken) {
    await assertUsernameFree(c, fields.username);
    try {
      result = await registerWithInvite(c.env.DB, { ...fields, inviteToken });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'that username is already taken');
      throw e;
    }
    if (!result) throw new ApiError(400, 'this invite link is invalid, expired or has already been used');
  } else {
    if (!registrationOpen(c.env)) {
      throw new ApiError(403, 'self-service sign-up is disabled on this deployment — ask an operator for an invite link');
    }
    // The deployment owner claims the default workspace via first-run setup
    // before strangers can sign up.
    if ((await countAccounts(c.env.DB)) === 0) {
      throw new ApiError(409, 'this deployment has not been set up yet');
    }
    const workspaceName = cleanWorkspaceName(body.workspaceName);
    if (!workspaceName) throw new ApiError(400, 'workspace name must be 2-80 characters');

    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const rateKey = `regrate:${ip}`;
    const recent = parseInt((await c.env.KV.get(rateKey)) ?? '0', 10);
    if (recent >= MAX_REGISTRATIONS_PER_HOUR) {
      throw new ApiError(429, 'too many sign-ups from this network — try again later');
    }
    await assertUsernameFree(c, fields.username);
    try {
      result = await registerWorkspace(c.env.DB, { ...fields, workspaceName });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'that username is already taken');
      throw e;
    }
    await c.env.KV.put(rateKey, String(recent + 1), { expirationTtl: 3600 });
  }

  const { token } = await createSession(c.env.DB, result.accountId, c.req.header('user-agent'));
  setSessionCookie(c, token);
  await logEvent(c.env.DB, {
    message: `${inviteToken ? 'operator joined via invite' : 'new workspace registered'}: ${fields.username.toLowerCase()} (${result.workspaceId})`,
  });
  return c.json(
    { ok: true, account: { id: result.accountId, username: fields.username.toLowerCase(), workspaceId: result.workspaceId } },
    201
  );
});

// Public: lets the join page show which workspace an invite is for.
authApi.get('/invites/lookup', async (c) => {
  const workspace = await lookupInvite(c.env.DB, c.req.query('token') ?? '');
  if (!workspace) return c.json({ error: 'this invite link is invalid, expired or has already been used' }, 404);
  return c.json({ workspace: { name: workspace.name } });
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
  const caller = await requireCaller(c);
  if (!caller.account) {
    return c.json({ error: 'sign in with username/password to change your password' }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    currentPassword?: string;
    newPassword?: string;
  };
  const account = await getAccountById(c.env.DB, caller.account.id);
  if (!account || !(await verifyPassword(body.currentPassword ?? '', account.passwordHash))) {
    return c.json({ error: 'current password is incorrect' }, 401);
  }
  const pwError = validPassword(body.newPassword ?? '');
  if (pwError) return c.json({ error: pwError }, 400);
  await setAccountPassword(c.env.DB, account.id, body.newPassword!);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Workspace (the caller's own)

authApi.get('/workspace', async (c) => {
  const caller = await requireCaller(c);
  const workspace = await getWorkspace(c.env.DB, caller.workspaceId);
  if (!workspace) throw new ApiError(404, 'workspace not found');
  return c.json({ workspace });
});

authApi.patch('/workspace', async (c) => {
  const caller = await requireCaller(c);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = cleanWorkspaceName(body.name);
  if (!name) throw new ApiError(400, 'workspace name must be 2-80 characters');
  await renameWorkspace(c.env.DB, caller.workspaceId, name);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team management (any operator in the workspace, or the API token)

/** Load an account by id, as a 404 unless it is in the caller's workspace. */
async function loadTeamAccount(c: Ctx, caller: Caller, id: string) {
  const target = await getAccountById(c.env.DB, id);
  if (!target || target.workspaceId !== caller.workspaceId) throw new ApiError(404, 'account not found');
  return target;
}

authApi.get('/accounts', async (c) => {
  const caller = await requireCaller(c);
  return c.json({ accounts: await listAccounts(c.env.DB, caller.workspaceId) });
});

authApi.post('/accounts', async (c) => {
  const caller = await requireCaller(c);
  const fields = newAccountFields((await c.req.json().catch(() => ({}))) as CredentialsBody);
  await assertUsernameFree(c, fields.username);
  const id = await createAccount(c.env.DB, { ...fields, workspaceId: caller.workspaceId });
  await logEvent(c.env.DB, { message: `operator account created: ${fields.username.toLowerCase()}` });
  return c.json({ id }, 201);
});

authApi.post('/accounts/:id/reset-password', async (c) => {
  const caller = await requireCaller(c);
  const target = await loadTeamAccount(c, caller, c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { newPassword?: string };
  const pwError = validPassword(body.newPassword ?? '');
  if (pwError) return c.json({ error: pwError }, 400);
  await setAccountPassword(c.env.DB, target.id, body.newPassword!);
  await logEvent(c.env.DB, { message: `password reset for operator account: ${target.username}` });
  return c.json({ ok: true });
});

authApi.delete('/accounts/:id', async (c) => {
  const caller = await requireCaller(c);
  const target = await loadTeamAccount(c, caller, c.req.param('id'));
  if (caller.account && caller.account.id === target.id) {
    return c.json({ error: 'you cannot delete your own account' }, 409);
  }
  if ((await countWorkspaceAccounts(c.env.DB, caller.workspaceId)) <= 1) {
    return c.json({ error: 'cannot delete the last account in a workspace' }, 409);
  }
  await deleteAccount(c.env.DB, target.id);
  await logEvent(c.env.DB, { message: `operator account deleted: ${target.username}` });
  return c.json({ ok: true });
});

// Invite links: the raw token appears only in this response (as part of the
// link); the database keeps its hash.
authApi.get('/invites', async (c) => {
  const caller = await requireCaller(c);
  return c.json({ invites: await listInvites(c.env.DB, caller.workspaceId) });
});

authApi.post('/invites', async (c) => {
  const caller = await requireCaller(c);
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const invite = await createInvite(c.env.DB, {
    workspaceId: caller.workspaceId,
    createdBy: caller.account?.id,
    note: body.note?.trim().slice(0, 200) || undefined,
  });
  const url = `${new URL(c.req.url).origin}/#/join/${invite.token}`;
  return c.json({ id: invite.id, url, expiresAt: invite.expiresAt, ttlSeconds: INVITE_TTL_SECONDS }, 201);
});

authApi.delete('/invites/:id', async (c) => {
  const caller = await requireCaller(c);
  if (!(await revokeInvite(c.env.DB, caller.workspaceId, c.req.param('id')))) {
    throw new ApiError(404, 'invite not found');
  }
  return c.json({ ok: true });
});
