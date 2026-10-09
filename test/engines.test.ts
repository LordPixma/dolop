// Workload engine tests: run the real engines tick by tick (tight budgets,
// throttling, passes stopped mid-way) against a fake Graph, and assert that
// every source item lands in the destination exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarEngine } from '../src/engine/calendar';
import { ContactsEngine } from '../src/engine/contacts';
import { DriveEngine } from '../src/engine/drive';
import { MailEngine } from '../src/engine/mail';
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

// ---------------------------------------------------------------------------
// Delta engines: a pass that stops mid-page must not lose that page

describe('mail engine', () => {
  function mailbox(n: number, attachments: Record<string, number> = {}) {
    const source = range(n).map((i) => ({
      id: `m${i}`,
      subject: `Message ${i}`,
      receivedDateTime: '2026-01-01T00:00:00Z',
      body: { contentType: 'text', content: 'hello' },
      hasAttachments: (attachments[`m${i}`] ?? 0) > 0,
    }));
    const created: { id: string; subject: string; attachments: string[] }[] = [];
    fake
      .route('GET', /^\/users\/src\/mailFolders\/inbox$/, () =>
        json({ id: 'f-src', displayName: 'Inbox', childFolderCount: 0, totalItemCount: n })
      )
      .route('GET', /^\/users\/dst\/mailFolders\/inbox$/, () => json({ id: 'f-dst', displayName: 'Inbox' }))
      .route('GET', /^\/users\/src\/mailFolders$/, () =>
        json({ value: [{ id: 'f-src', displayName: 'Inbox', childFolderCount: 0, totalItemCount: n }] })
      )
      .route('GET', /^\/users\/src\/mailFolders\/f-src\/messages\/delta$/, (req) =>
        pageOf(source.map((m) => ({ id: m.id })), req, { delta: true })
      )
      .route('GET', /^\/users\/src\/messages\/([^/]+)\/attachments$/, (req) =>
        json({
          value: range(attachments[req.m[1]!] ?? 0).map((j) => ({ id: `${req.m[1]}-a${j}`, name: `file${j}.txt`, size: 5 })),
        })
      )
      .route('GET', /^\/users\/src\/messages\/([^/]+)\/attachments\/([^/]+)$/, (req) =>
        json({ '@odata.type': '#microsoft.graph.fileAttachment', id: req.m[2], name: `${req.m[2]}.txt`, contentBytes: 'aGVsbG8=' })
      )
      .route('GET', /^\/users\/src\/messages\/([^/]+)$/, (req) => json(source.find((m) => m.id === req.m[1])))
      .route('POST', /^\/users\/dst\/mailFolders\/f-dst\/messages$/, (req) => {
        const id = `dm${created.length}`;
        created.push({ id, subject: req.body.subject, attachments: [] });
        return json({ id }, 201);
      })
      .route('POST', /^\/users\/dst\/messages\/([^/]+)\/attachments$/, (req) => {
        created.find((c) => c.id === req.m[1])!.attachments.push(req.body.name);
        return json({ id: 'att' }, 201);
      });
    return { source, created };
  }

  it('does not lose the rest of a page when a pass stops mid-page', async () => {
    const { source, created } = mailbox(100); // delta pages of 40, 25 messages per tick
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine(), { until: () => created.length >= 50 }); // stopped inside page 2
    h.newPass();
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), source.map((m) => m.subject));
  });

  it('finishes a half-copied message on the next pass instead of duplicating it', async () => {
    const { source, created } = mailbox(10, { m3: 2 });
    fake.throttle('POST', /^\/users\/dst\/messages\/[^/]+\/attachments$/, { after: 1 }); // m3's second attachment
    const h = new EngineHarness(FULL);
    const engine = new MailEngine();
    let outcome;
    for (let i = 0; i < 20 && outcome !== 'throttled'; i++) outcome = await h.tick(engine);
    expect(outcome).toBe('throttled');
    // the pass is stopped here, then a new pass starts
    h.newPass();
    await h.run(engine);
    expectEachOnce(created.map((c) => c.subject), source.map((m) => m.subject));
    expect(created.find((c) => c.subject === 'Message 3')!.attachments.sort()).toEqual(['m3-a0.txt', 'm3-a1.txt']);
  });
});

describe('drive engine', () => {
  const MB = 1024 * 1024;

  function oneDrive(files: { name: string; size: number }[]) {
    const items = [
      { id: 'root', root: {} },
      ...files.map((f, i) => ({
        id: `f${i}`,
        name: f.name,
        size: f.size,
        file: {},
        cTag: `ctag-${i}`,
        parentReference: { path: '/drive/root:' },
        '@microsoft.graph.downloadUrl': `https://download.test/f${i}`,
      })),
    ];
    const uploaded: string[] = []; // completed destination files, by name
    const sessions = new Map<string, { name: string; size: number; received: number }>();
    fake
      .route('GET', /^\/users\/src\/drive$/, () => json({ id: 'src-drive', quota: { used: 1 } }))
      .route('GET', /^\/users\/dst\/drive$/, () => json({ id: 'dst-drive' }))
      .route('GET', /^\/drives\/src-drive\/root\/delta$/, (req) => pageOf(items, req, { delta: true }))
      .route('GET', /^\/drives\/dst-drive\/root$/, () => json({ id: 'droot' }))
      .route('GET', /^download\.test\/(f\d+)$/, (req) => {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(req.headers.get('range') ?? '') ?? [];
        return new Response(new Uint8Array(Number(end) - Number(start) + 1), { status: 206 });
      })
      .route('PUT', /^\/drives\/dst-drive\/items\/droot:\/([^/:]+):\/content$/, (req) => {
        uploaded.push(decodeURIComponent(req.m[1]!));
        return json({ id: `d-${req.m[1]}` }, 201);
      })
      .route('PATCH', /^\/drives\/dst-drive\/items\/[^/]+$/, () => json({}))
      .route('POST', /^\/drives\/dst-drive\/items\/droot:\/([^/:]+):\/createUploadSession$/, (req) => {
        const id = `s${sessions.size}`;
        const file = files.find((f) => f.name === decodeURIComponent(req.m[1]!))!;
        sessions.set(id, { name: file.name, size: file.size, received: 0 });
        return json({ uploadUrl: `https://upload.test/${id}` });
      })
      .route('PUT', /^upload\.test\/(s\d+)$/, (req) => {
        const s = sessions.get(req.m[1]!)!;
        s.received += req.raw?.byteLength ?? 0;
        if (s.received < s.size) return json({ nextExpectedRanges: [`${s.received}-`] }, 202);
        uploaded.push(s.name);
        return json({ id: `d-${s.name}` }, 201);
      });
    return { uploaded };
  }

  it('does not lose queued files when a pass stops mid-page', async () => {
    const files = range(150).map((i) => ({ name: `file${i}.txt`, size: 10 }));
    const { uploaded } = oneDrive(files); // delta pages of 100, 25 files per tick
    const h = new EngineHarness(FULL);
    await h.run(new DriveEngine(), { until: () => uploaded.length >= 40 });
    h.newPass();
    await h.run(new DriveEngine());
    expectEachOnce(uploaded, files.map((f) => f.name));
  });

  it('re-copies a large file whose upload was interrupted by a stopped pass', async () => {
    const files = [
      { name: 'small.txt', size: 10 },
      { name: 'big.bin', size: 25 * MB }, // three 10 MiB chunks
    ];
    const { uploaded } = oneDrive(files);
    fake.throttle('PUT', /^upload\.test\/s0$/, { after: 1 }); // first chunk lands, second is throttled
    const h = new EngineHarness(FULL);
    const engine = new DriveEngine();
    let outcome;
    for (let i = 0; i < 10 && outcome !== 'throttled'; i++) outcome = await h.tick(engine);
    expect(outcome).toBe('throttled');
    expect(uploaded).toEqual(['small.txt']);
    // the pass is stopped mid-upload, then a new pass starts
    h.newPass();
    await h.run(engine);
    expect(uploaded.sort()).toEqual(['big.bin', 'small.txt']);
    expect(h.errors).toEqual([]);
  });
});
