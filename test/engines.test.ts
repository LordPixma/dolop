// Workload engine tests: run the real engines tick by tick (tight budgets,
// throttling, passes stopped mid-way) against a fake Graph, and assert that
// every source item lands in the destination exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarEngine } from '../src/engine/calendar';
import { ContactsEngine } from '../src/engine/contacts';
import { resumeIndex } from '../src/engine/paged';
import { TasksEngine } from '../src/engine/tasks';
import type { PassConfig } from '../src/types';
import { EngineHarness, FakeGraph, json, pageOf, range, tally } from './support/engine';

const FULL: PassConfig = { passType: 'full', workloads: ['mail', 'calendar', 'contacts', 'tasks', 'drive'], filters: {} };

let fake: FakeGraph;
beforeEach(() => {
  fake = new FakeGraph();
  vi.stubGlobal('fetch', fake.fetch);
});
afterEach(() => vi.unstubAllGlobals());

/** Every value appears exactly once. */
function expectEachOnce(values: string[], expected: string[]): void {
  const counts = tally(values);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([v]) => v);
  const missing = expected.filter((v) => !counts.has(v));
  expect({ dupes, missing, total: values.length }).toEqual({ dupes: [], missing: [], total: expected.length });
}

// ---------------------------------------------------------------------------
// Paged item engines: work that stops mid-page must resume mid-page

describe('resumeIndex', () => {
  const page = (...ids: string[]) => ids.map((id) => ({ id }));

  it('resumes at the saved index when the page is unchanged', () => {
    expect(resumeIndex(page('a', 'b', 'c', 'd'), { index: 2, lastId: 'b' })).toBe(2);
    expect(resumeIndex(page('a', 'b'), { index: 0 })).toBe(0);
  });

  it('re-anchors on the last handled item when earlier items moved', () => {
    // 'a' was deleted at the source between ticks: a bare index would skip 'c'
    expect(resumeIndex(page('b', 'c', 'd'), { index: 2, lastId: 'b' })).toBe(1);
    // an item was inserted before the anchor
    expect(resumeIndex(page('x', 'a', 'b', 'c'), { index: 2, lastId: 'b' })).toBe(3);
  });

  it('starts the page over when the anchor item is gone', () => {
    expect(resumeIndex(page('c', 'd'), { index: 2, lastId: 'b' })).toBe(0);
  });
});

describe('contacts engine', () => {
  function contactsTenant(n: number) {
    const source = range(n).map((i) => ({ id: `c${i}`, givenName: `Contact ${i}` }));
    const created: string[] = [];
    fake
      .route('GET', /^\/users\/(src|dst)\/contactFolders$/, () => json({ value: [] }))
      .route('GET', /^\/users\/src\/contacts$/, (req) => pageOf(source, req))
      .route('POST', /^\/users\/dst\/contacts$/, (req) => {
        created.push(req.body.givenName);
        return json({ id: `dc${created.length}` }, 201);
      });
    return { source, created };
  }

  it('migrates every contact although pages are larger than the per-tick item budget', async () => {
    const { source, created } = contactsTenant(120);
    const h = new EngineHarness(FULL);
    await h.run(new ContactsEngine());
    expectEachOnce(created, source.map((c) => c.givenName));
    expect(h.stats.contacts).toMatchObject({ discovered: 120, migrated: 120, skipped: 0, failed: 0 });
  });

  it('re-walks an already migrated folder on the next pass without copying again', async () => {
    const { created } = contactsTenant(120);
    const h = new EngineHarness(FULL);
    await h.run(new ContactsEngine());
    h.newPass();
    const ticks = await h.run(new ContactsEngine());
    expect(created).toHaveLength(120);
    expect(h.stats.contacts).toMatchObject({ discovered: 120, migrated: 0, skipped: 120 });
    // id-map skips cost no Graph calls, so they don't eat the per-tick item budget
    expect(ticks).toBeLessThanOrEqual(3);
  });
});

describe('calendar engine', () => {
  it('resumes mid-page when the subrequest budget runs out', async () => {
    const source = range(60).map((i) => ({
      id: `e${i}`,
      subject: `Event ${i}`,
      type: 'singleInstance',
      start: { dateTime: '2026-01-01T09:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-01-01T10:00:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'x@y.test' } }], // stripped → extension call per event
    }));
    const created: string[] = [];
    let extensions = 0;
    fake
      .route('GET', /^\/users\/src\/calendar$/, () => json({ id: 'cal-src' }))
      .route('GET', /^\/users\/dst\/calendar$/, () => json({ id: 'cal-dst' }))
      .route('GET', /^\/users\/src\/calendars$/, () => json({ value: [{ id: 'cal-src', name: 'Calendar', isDefaultCalendar: true }] }))
      .route('GET', /^\/users\/dst\/calendars$/, () => json({ value: [{ id: 'cal-dst', name: 'Calendar' }] }))
      .route('GET', /^\/users\/src\/calendars\/cal-src\/events$/, (req) => pageOf(source, req))
      .route('POST', /^\/users\/dst\/calendars\/cal-dst\/events$/, (req) => {
        created.push(req.body.subject);
        return json({ id: `de${created.length}` }, 201);
      })
      .route('POST', /^\/users\/dst\/events\/[^/]+\/extensions$/, () => {
        extensions++;
        return json({}, 201);
      });

    const h = new EngineHarness(FULL, { maxSubrequests: 11 });
    await h.run(new CalendarEngine());
    expectEachOnce(created, source.map((e) => e.subject));
    expect(extensions).toBe(60);
  });
});

describe('tasks engine', () => {
  it('resumes mid-page when checklist items use up the subrequest budget', async () => {
    const source = range(40).map((i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      checklistItems: range(3).map((j) => ({ displayName: `Step ${i}.${j}` })),
    }));
    const created: string[] = [];
    const checklist: string[] = [];
    fake
      .route('GET', /^\/users\/src\/todo\/lists$/, () =>
        json({ value: [{ id: 'l-src', displayName: 'Tasks', wellknownListName: 'defaultList' }] })
      )
      .route('GET', /^\/users\/dst\/todo\/lists$/, () =>
        json({ value: [{ id: 'l-dst', displayName: 'Tasks', wellknownListName: 'defaultList' }] })
      )
      .route('GET', /^\/users\/src\/todo\/lists\/l-src\/tasks$/, (req) => pageOf(source, req))
      .route('POST', /^\/users\/dst\/todo\/lists\/l-dst\/tasks$/, (req) => {
        created.push(req.body.title);
        return json({ id: `dt${created.length}` }, 201);
      })
      .route('POST', /^\/users\/dst\/todo\/lists\/l-dst\/tasks\/[^/]+\/checklistItems$/, (req) => {
        checklist.push(req.body.displayName);
        return json({}, 201);
      });

    const h = new EngineHarness(FULL); // 25-task pages × 4 calls each overrun 80 subrequests
    await h.run(new TasksEngine());
    expectEachOnce(created, source.map((t) => t.title));
    expectEachOnce(checklist, source.flatMap((t) => t.checklistItems.map((c) => c.displayName)));
  });
});
