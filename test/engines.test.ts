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
import { calendarTenant, contactsTenant, event, mailbox, mailTenant, tasksTenant } from './support/tenants';

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
  it('migrates every contact although pages are larger than the per-tick item budget', async () => {
    const { all, created } = contactsTenant(fake, { defaultCount: 120 });
    const h = new EngineHarness(FULL);
    await h.run(new ContactsEngine());
    expectEachOnce(created.map((c) => c.name), all);
    expect(h.stats.contacts).toMatchObject({ discovered: 120, migrated: 120, skipped: 0, failed: 0 });
  });

  it('re-walks an already migrated folder on the next pass without copying again', async () => {
    const { created } = contactsTenant(fake, { defaultCount: 120 });
    const h = new EngineHarness(FULL);
    await h.run(new ContactsEngine());
    h.newPass();
    const ticks = await h.run(new ContactsEngine());
    expect(created).toHaveLength(120);
    expect(h.stats.contacts).toMatchObject({ discovered: 120, migrated: 0, skipped: 120 });
    // id-map skips cost no Graph calls, so they don't eat the per-tick item budget
    expect(ticks).toBeLessThanOrEqual(3);
  });

  it('does not queue folders twice when folder setup is throttled', async () => {
    const { all, created, destFolders } = contactsTenant(fake, {
      defaultCount: 4,
      folders: [
        { name: 'Friends', count: 4 },
        { name: 'Work', count: 4 },
      ],
    });
    fake.throttle('POST', /^\/users\/dst\/contactFolders$/, { after: 1 });
    const h = new EngineHarness(FULL);
    await h.run(new ContactsEngine());
    expectEachOnce(created.map((c) => c.name), all);
    expect(destFolders).toEqual(['Friends', 'Work']);
    expect(h.stats.contacts).toMatchObject({ discovered: 12, migrated: 12, skipped: 0 });
  });
});

describe('calendar engine', () => {
  it('resumes mid-page when the subrequest budget runs out', async () => {
    const events = range(60).map((i) => event(`e${i}`, { attendees: [{ emailAddress: { address: 'x@y.test' } }] }));
    const { created, extensions } = calendarTenant(fake, [{ id: 'cal-src', name: 'Calendar', isDefault: true, events }]);
    const h = new EngineHarness(FULL, { maxSubrequests: 11 }); // stripped attendees → extension call per event
    await h.run(new CalendarEngine());
    expectEachOnce(created.map((c) => c.subject), events.map((e) => e.subject!));
    expect(extensions).toHaveLength(60);
  });

  it('does not queue calendars twice when calendar setup is throttled', async () => {
    const cal = (id: string, name: string, isDefault = false) => ({
      id,
      name,
      isDefault,
      events: range(4).map((i) => event(`${id}-${i}`)),
    });
    const calendars = [cal('c1', 'Calendar', true), cal('c2', 'Team'), cal('c3', 'Holidays')];
    const { created, destCalendars } = calendarTenant(fake, calendars);
    fake.throttle('POST', /^\/users\/dst\/calendars$/, { after: 1 });
    const h = new EngineHarness(FULL);
    await h.run(new CalendarEngine());
    expectEachOnce(created.map((c) => c.subject), calendars.flatMap((c) => c.events.map((e) => e.subject!)));
    expect(destCalendars).toEqual(['Team', 'Holidays']);
    expect(h.stats.calendar).toMatchObject({ discovered: 12, migrated: 12, skipped: 0 });
  });
});

describe('tasks engine', () => {
  const task = (id: string, steps = 0) => ({
    id,
    title: `Task ${id}`,
    checklistItems: range(steps).map((j) => ({ id: `${id}-s${j}`, displayName: `Step ${id}.${j}` })),
  });

  it('resumes mid-page when checklist items use up the subrequest budget', async () => {
    const tasks = range(40).map((i) => task(`t${i}`, 3));
    const { created, checklist } = tasksTenant(fake, [{ id: 'l1', name: 'Tasks', isDefault: true, tasks }]);
    const h = new EngineHarness(FULL); // 25-task pages × 4 calls each overrun 80 subrequests
    await h.run(new TasksEngine());
    expectEachOnce(created.map((t) => t.title), tasks.map((t) => t.title));
    expectEachOnce(checklist.map((c) => c.name), tasks.flatMap((t) => t.checklistItems.map((c) => c.displayName)));
  });

  it('does not queue lists twice when list setup is throttled', async () => {
    const list = (id: string, name: string, isDefault = false) => ({
      id,
      name,
      isDefault,
      tasks: range(3).map((i) => task(`${id}-${i}`)),
    });
    const lists = [list('l1', 'Tasks', true), list('l2', 'Groceries'), list('l3', 'Chores')];
    const { created, destLists } = tasksTenant(fake, lists);
    fake.throttle('POST', /^\/users\/dst\/todo\/lists$/, { after: 1 });
    const h = new EngineHarness(FULL);
    await h.run(new TasksEngine());
    expectEachOnce(created.map((t) => t.title), lists.flatMap((l) => l.tasks.map((t) => t.title)));
    expect(destLists).toEqual(['Groceries', 'Chores']);
    expect(h.stats.tasks).toMatchObject({ discovered: 9, migrated: 9, skipped: 0 });
  });
});

describe('throttling never duplicates or drops work', () => {
  it('mail: a throttle while listing a new message\'s attachments resumes that message', async () => {
    const { allMessages, created } = mailbox(fake, 4, { 1: 2 });
    fake.throttle('GET', /^\/users\/src\/messages\/[^/]+\/attachments$/);
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
    expect(created.find((c) => c.subject === 'Inbox 1')!.attachments).toHaveLength(2);
  });

  it('mail: a throttled Message-ID dedupe lookup pauses instead of creating a duplicate', async () => {
    const { allMessages, created } = mailbox(fake, 6);
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    // migration state is reset (e.g. after remapping), then re-run with dedupe on
    h.store.wipe();
    h.newPass({ ...FULL, filters: { mailDedupeByMessageId: true } });
    fake.throttle('GET', /^\/users\/dst\/messages$/, { after: 2 });
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
  });

  it('tasks: a throttled checklist item resumes the checklist instead of dropping it', async () => {
    const tasks = [{ id: 't1', title: 'Task t1', checklistItems: range(3).map((j) => ({ id: `s${j}`, displayName: `Step ${j}` })) }];
    const { created, checklist } = tasksTenant(fake, [{ id: 'l1', name: 'Tasks', isDefault: true, tasks }]);
    fake.throttle('POST', /\/checklistItems$/, { after: 1 });
    const h = new EngineHarness(FULL);
    await h.run(new TasksEngine());
    expect(created.map((t) => t.title)).toEqual(['Task t1']);
    expectEachOnce(checklist.map((c) => c.name), ['Step 0', 'Step 1', 'Step 2']);
    expect(h.errors).toEqual([]);
  });

  it('calendar: a throttled attendee extension is retried, not dropped', async () => {
    const events = [event('e1', { attendees: [{ emailAddress: { address: 'x@y.test' } }] })];
    const { created, extensions } = calendarTenant(fake, [{ id: 'c1', name: 'Calendar', isDefault: true, events }]);
    fake.throttle('POST', /\/extensions$/);
    const h = new EngineHarness(FULL);
    await h.run(new CalendarEngine());
    expect(created).toHaveLength(1);
    expect(extensions).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });
});

describe('failed items are retried on later passes', () => {
  it('contacts: a contact that failed is copied by the next pass', async () => {
    const { all, created } = contactsTenant(fake, { defaultCount: 5 });
    fake.fail('POST', /^\/users\/dst\/contacts$/, { after: 2, status: 400 });
    const h = new EngineHarness(FULL);
    await h.run(new ContactsEngine());
    expect(created).toHaveLength(4);
    expect(h.stats.contacts).toMatchObject({ migrated: 4, failed: 1 });
    h.newPass();
    await h.run(new ContactsEngine());
    expectEachOnce(created.map((c) => c.name), all);
  });

  it('contacts: items an older version marked "failed" in the id map are retried', async () => {
    const { all, created } = contactsTenant(fake, { defaultCount: 3 });
    const h = new EngineHarness(FULL);
    h.store.mapPut('contacts', 'item', 'c1', 'failed');
    await h.run(new ContactsEngine());
    expectEachOnce(created.map((c) => c.name), all);
  });

  it('tasks: a task that failed is copied by the next pass', async () => {
    const tasks = range(3).map((i) => ({ id: `t${i}`, title: `Task ${i}` }));
    const { created } = tasksTenant(fake, [{ id: 'l1', name: 'Tasks', isDefault: true, tasks }]);
    fake.fail('POST', /^\/users\/dst\/todo\/lists\/[^/]+\/tasks$/, { after: 1, status: 400 });
    const h = new EngineHarness(FULL);
    await h.run(new TasksEngine());
    h.newPass();
    await h.run(new TasksEngine());
    expectEachOnce(created.map((t) => t.title), tasks.map((t) => t.title));
  });

  it('mail: a message that failed is copied by the next pass, without a duplicate', async () => {
    const { allMessages, created } = mailbox(fake, 5);
    fake.fail('POST', /^\/users\/dst\/mailFolders\/[^/]+\/messages$/, { after: 2 });
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    expect(created).toHaveLength(4);
    expect(h.stats.mail).toMatchObject({ migrated: 4, failed: 1 });
    h.newPass();
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
    expect(h.stats.mail).toMatchObject({ migrated: 1, failed: 0 });
  });

  it('mail: gives up on a message after three failed passes', async () => {
    const { created } = mailbox(fake, 2);
    fake.fail('GET', /^\/users\/src\/messages\/f-inbox-m1$/, { times: 6, status: 400 });
    const h = new EngineHarness(FULL);
    for (let pass = 1; pass <= 4; pass++) {
      if (pass > 1) h.newPass();
      await h.run(new MailEngine());
      expect(h.stats.mail?.failed ?? 0, `pass ${pass}`).toBe(pass <= 3 ? 1 : 0);
    }
    expect(created.map((c) => c.subject)).toEqual(['Inbox 0']);
  });

  it('mail: a retried message is matched by Message-ID if the failed POST actually created it', async () => {
    const { allMessages, created } = mailbox(fake, 3);
    // the POST for the 2nd message "fails" after the destination already stored it
    let posts = 0;
    fake.route('POST', /^\/users\/dst\/mailFolders\/[^/]+\/messages$/, (req) => {
      const id = `dm${created.length}`;
      created.push({ id, folder: 'f', subject: req.body.subject, internetMessageId: req.body.internetMessageId, attachments: [] });
      return ++posts === 2 ? json({ error: { code: 'ServiceUnavailable', message: 'late' } }, 500) : json({ id }, 201);
    });
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    h.newPass();
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
  });
});

// ---------------------------------------------------------------------------
// Delta engines: a pass that stops mid-page must not lose that page

describe('mail engine', () => {
  it('does not lose the rest of a page when a pass stops mid-page', async () => {
    const { allMessages, created } = mailbox(fake, 100); // delta pages of 40, 25 messages per tick
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine(), { until: () => created.length >= 50 }); // stopped inside page 2
    h.newPass();
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
  });

  it('finishes a half-copied message on the next pass instead of duplicating it', async () => {
    const { allMessages, created } = mailbox(fake, 10, { 3: 2 });
    fake.throttle('POST', /^\/users\/dst\/messages\/[^/]+\/attachments$/, { after: 1 }); // its second attachment
    const h = new EngineHarness(FULL);
    const engine = new MailEngine();
    let outcome;
    for (let i = 0; i < 20 && outcome !== 'throttled'; i++) outcome = await h.tick(engine);
    expect(outcome).toBe('throttled');
    // the pass is stopped here, then a new pass starts
    h.newPass();
    await h.run(engine);
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
    expect(created.find((c) => c.subject === 'Inbox 3')!.attachments.sort()).toEqual([
      'f-inbox-m3-a0.txt',
      'f-inbox-m3-a1.txt',
    ]);
  });

  it('keeps subfolders of an excluded Deleted Items folder out of the mailbox', async () => {
    const { messages, created, destFolders } = mailTenant(fake, [
      { id: 'f-inbox', name: 'Inbox', wellKnown: 'inbox', messages: 3 },
      { id: 'f-deleted', name: 'Deleted Items', wellKnown: 'deleteditems', messages: 2 },
      { id: 'f-old', name: 'Project X', parent: 'f-deleted', messages: 4 },
    ]);
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), messages.get('f-inbox')!.map((m) => m.subject));
    expect([...destFolders.values()].map((f) => f.name)).not.toContain('Project X');
  });

  it('does not queue folders twice when folder setup is throttled', async () => {
    const { allMessages, created, destFolders } = mailTenant(fake, [
      { id: 'f-inbox', name: 'Inbox', wellKnown: 'inbox', messages: 5 },
      { id: 'f-a', name: 'Alpha', messages: 3 },
      { id: 'f-b', name: 'Beta', messages: 3 },
    ]);
    fake.throttle('POST', /^\/users\/dst\/mailFolders$/, { after: 1 }); // Beta's creation
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
    expect([...destFolders.values()].filter((f) => f.name === 'Beta')).toHaveLength(1);
    expect(h.stats.mail).toMatchObject({ expected: 11, discovered: 11, migrated: 11 });
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
      .route('GET', /^\/drives\/src-drive\/items\/([^/]+)$/, (req) => json(items.find((x) => x.id === req.m[1])))
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

  it('copies a file that failed on the next pass', async () => {
    const files = range(4).map((i) => ({ name: `file${i}.txt`, size: 10 }));
    const { uploaded } = oneDrive(files);
    fake.fail('PUT', /file2\.txt:\/content$/, { times: 2 }); // the client's one retry fails too
    const h = new EngineHarness(FULL);
    await h.run(new DriveEngine());
    expect(uploaded.sort()).toEqual(['file0.txt', 'file1.txt', 'file3.txt']);
    expect(h.stats.drive).toMatchObject({ migrated: 3, failed: 1 });
    h.newPass();
    await h.run(new DriveEngine());
    expectEachOnce(uploaded, files.map((f) => f.name));
    expect(h.stats.drive).toMatchObject({ migrated: 1, failed: 0 });
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
