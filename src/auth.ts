// API authentication. Requests are accepted with either:
//   - a valid operator session cookie (username/password login), or
//   - `Authorization: Bearer <API_TOKEN>` (automation/CI and password recovery).
// Every authenticated request is pinned to one workspace: a session uses its
// account's workspace; the API token (a deployment-wide root credential) uses
// the default workspace unless `X-Dolop-Workspace: <id>` selects another.
// For production deployments, additionally put the Worker behind Cloudflare
// Access so requests are authenticated at the edge before reaching it.

import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { ensureDefaultWorkspace, getSessionAccount, getWorkspace, SESSION_COOKIE, type Account } from './accounts';
import type { AppEnv } from './types';
import { timingSafeEqual } from './util';

export interface Caller {
  account: Account | null;
  workspaceId: string;
  via: 'session' | 'token';
}

/**
 * Identify the caller. Returns null when unauthenticated, or the string
 * 'unknown-workspace' when a valid API token names a workspace that does not exist.
 */
export async function resolveCaller(c: Context<AppEnv>): Promise<Caller | 'unknown-workspace' | null> {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = c.env.API_TOKEN;
    if (!token || !timingSafeEqual(header.slice(7), token)) return null;
    const requested = c.req.header('x-dolop-workspace');
    const workspace = requested
      ? await getWorkspace(c.env.DB, requested)
      : await ensureDefaultWorkspace(c.env.DB);
    if (!workspace) return 'unknown-workspace';
    return { account: null, workspaceId: workspace.id, via: 'token' };
  }

  const cookie = getCookie(c, SESSION_COOKIE) ?? '';
  const account = cookie ? await getSessionAccount(c.env.DB, cookie) : null;
  return account ? { account, workspaceId: account.workspaceId, via: 'session' } : null;
}

export async function requireAuth(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const caller = await resolveCaller(c);
  if (caller === 'unknown-workspace') return c.json({ error: 'workspace not found' }, 404);
  if (!caller) return c.json({ error: 'unauthorized' }, 401);
  c.set('workspaceId', caller.workspaceId);
  c.set('account', caller.account);
  await next();
}
