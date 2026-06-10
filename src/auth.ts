// API authentication. Requests are accepted with either:
//   - a valid operator session cookie (username/password login), or
//   - `Authorization: Bearer <API_TOKEN>` (automation/CI and password recovery).
// For production deployments, additionally put the Worker behind Cloudflare
// Access so requests are authenticated at the edge before reaching it.

import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { getSessionAccount, SESSION_COOKIE } from './accounts';
import type { Env } from './types';
import { timingSafeEqual } from './util';

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = c.env.API_TOKEN;
    if (token && timingSafeEqual(header.slice(7), token)) {
      await next();
      return;
    }
    return c.json({ error: 'unauthorized' }, 401);
  }

  const cookie = getCookie(c, SESSION_COOKIE) ?? '';
  if (cookie && (await getSessionAccount(c.env.DB, cookie))) {
    await next();
    return;
  }
  return c.json({ error: 'unauthorized' }, 401);
}
