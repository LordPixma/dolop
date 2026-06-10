// API authentication. Every /api route requires `Authorization: Bearer <API_TOKEN>`.
// For production deployments, additionally put the Worker behind Cloudflare
// Access so requests are authenticated at the edge before reaching it.

import type { Context, Next } from 'hono';
import type { Env } from './types';
import { timingSafeEqual } from './util';

export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const token = c.env.API_TOKEN;
  if (!token) {
    return c.json(
      { error: 'API_TOKEN secret is not configured. Run: wrangler secret put API_TOKEN' },
      503
    );
  }
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !timingSafeEqual(presented, token)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
}
