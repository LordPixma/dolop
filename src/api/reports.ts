// CSV reporting. Reports are archived to R2 and streamed back to the caller.

import { Hono } from 'hono';
import { listAllProjectUsers, listItemErrors } from '../db';
import type { Env, WorkloadStats } from '../types';
import { nowIso, toCsv } from '../util';
import { loadProject } from './helpers';

export const reportsApi = new Hono<{ Bindings: Env }>();

function sumStats(stats: Record<string, WorkloadStats>): WorkloadStats {
  const out = { discovered: 0, migrated: 0, skipped: 0, failed: 0, bytes: 0 };
  for (const [key, s] of Object.entries(stats)) {
    if (key.startsWith('assessment')) continue;
    out.discovered += s.discovered ?? 0;
    out.migrated += s.migrated ?? 0;
    out.skipped += s.skipped ?? 0;
    out.failed += s.failed ?? 0;
    out.bytes += s.bytes ?? 0;
  }
  return out;
}

reportsApi.get('/:projectId/report', async (c) => {
  const project = await loadProject(c.env, c.req.param('projectId'));
  const type = c.req.query('type') === 'errors' ? 'errors' : 'users';

  let csv: string;
  if (type === 'users') {
    const users = await listAllProjectUsers(c.env.DB, project.id);
    csv = toCsv(
      [
        'source_upn',
        'dest_upn',
        'display_name',
        'status',
        'last_pass',
        'discovered',
        'migrated',
        'skipped',
        'failed',
        'bytes',
        'started_at',
        'completed_at',
        'error',
        'stats_json',
      ],
      users.map((u) => {
        const t = sumStats(u.stats);
        return [
          u.sourceUpn,
          u.destUpn,
          u.displayName ?? '',
          u.status,
          u.passType ?? '',
          t.discovered,
          t.migrated,
          t.skipped,
          t.failed,
          t.bytes,
          u.startedAt ?? '',
          u.completedAt ?? '',
          u.error ?? '',
          JSON.stringify(u.stats),
        ];
      })
    );
  } else {
    const users = await listAllProjectUsers(c.env.DB, project.id);
    const upnById = new Map(users.map((u) => [u.id, u.sourceUpn]));
    const all: Awaited<ReturnType<typeof listItemErrors>>['errors'] = [];
    for (let offset = 0; offset < 10_000; offset += 500) {
      const { errors, total } = await listItemErrors(c.env.DB, project.id, { limit: 500, offset });
      all.push(...errors);
      if (all.length >= total || errors.length === 0) break;
    }
    csv = toCsv(
      ['source_upn', 'workload', 'item_type', 'item_name', 'item_id', 'code', 'message', 'created_at'],
      all.map((e) => [
        upnById.get(e.userId) ?? e.userId,
        e.workload,
        e.itemType ?? '',
        e.itemName ?? '',
        e.itemId ?? '',
        e.code ?? '',
        e.message ?? '',
        e.createdAt,
      ])
    );
  }

  const key = `reports/${project.id}/${nowIso().replace(/[:.]/g, '-')}-${type}.csv`;
  await c.env.R2.put(key, csv, { httpMetadata: { contentType: 'text/csv' } });

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dolop-${type}-${project.name.replace(/[^a-z0-9-_]/gi, '_')}.csv"`,
      'x-dolop-r2-key': key,
    },
  });
});
