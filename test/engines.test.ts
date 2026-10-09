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
import {
  attachmentBytes,
  calendarTenant,
  contactsTenant,
  driveTenant,
  event,
  mailbox,
  mailTenant,
  tasksTenant,
  type DriveTree,
} from './support/tenants';

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

  it('creates recurring series in their original time zone, so they keep their local time across DST', async () => {
    const weekly = { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, range: { type: 'noEnd', startDate: '2026-01-05' } };
    const events = [
      event('series', {
        type: 'seriesMaster',
        recurrence: weekly,
        originalStartTimeZone: 'Pacific Standard Time',
        start: { dateTime: '2026-01-05T17:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-01-05T17:30:00.0000000', timeZone: 'UTC' },
      }),
      event('custom', { type: 'seriesMaster', recurrence: weekly, originalStartTimeZone: 'tzone://Microsoft/Custom' }),
      event('single', { originalStartTimeZone: 'Pacific Standard Time' }),
    ];
    const { created } = calendarTenant(fake, [{ id: 'c1', name: 'Calendar', isDefault: true, events }], {
      series: {
        start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: 'Pacific Standard Time' },
        end: { dateTime: '2026-01-05T09:30:00.0000000', timeZone: 'Pacific Standard Time' },
      },
    });
    const h = new EngineHarness(FULL);
    await h.run(new CalendarEngine());
    const bySubject = Object.fromEntries(created.map((c) => [c.subject, c.body]));
    expect(bySubject['Event series']!.start).toEqual({ dateTime: '2026-01-05T09:00:00.0000000', timeZone: 'Pacific Standard Time' });
    expect(bySubject['Event series']!.end).toEqual({ dateTime: '2026-01-05T09:30:00.0000000', timeZone: 'Pacific Standard Time' });
    // a legacy custom zone has no name Graph accepts; a single event is fine as an absolute time
    expect(bySubject['Event custom']!.start.timeZone).toBe('UTC');
    expect(bySubject['Event single']!.start.timeZone).toBe('UTC');
    expect(fake.log.filter((l) => l.startsWith('GET /users/src/events/'))).toEqual(['GET /users/src/events/series']);
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

describe('mail delta feed', () => {
  // mailbox() dates message i on 2026-01-(i+1)
  it('pre-stage copies only mail before the cutoff, then a full pass copies the rest', async () => {
    const { allMessages, created } = mailbox(fake, 10);
    const h = new EngineHarness(FULL);
    h.newPass({ ...FULL, passType: 'prestage', filters: { mailReceivedBefore: '2026-01-05T00:00:00.000Z' } });
    await h.run(new MailEngine());
    expect(created.map((c) => c.subject)).toEqual(['Inbox 0', 'Inbox 1', 'Inbox 2', 'Inbox 3', 'Inbox 4']);
    expect(h.stats.mail).toMatchObject({ migrated: 5, skipped: 5, failed: 0 });
    h.newPass(FULL);
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), allMessages.map((m) => m.subject));
  });

  it('applies a received-after cutoff without a server-side filter (Graph caps filtered delta at 5,000)', async () => {
    const { created, deltaUrls } = mailbox(fake, 6);
    const h = new EngineHarness({ ...FULL, filters: { mailReceivedAfter: '2026-01-04T00:00:00.000Z' } });
    await h.run(new MailEngine());
    expect(created.map((c) => c.subject)).toEqual(['Inbox 3', 'Inbox 4', 'Inbox 5']);
    expect(deltaUrls.length).toBeGreaterThan(0);
    expect(deltaUrls.filter((u) => new URL(u).searchParams.has('$filter'))).toEqual([]);
  });

  it('starts a folder over when its delta token has expired', async () => {
    const { messages, created } = mailbox(fake, 3);
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    // new mail arrives, and Graph has dropped the sync state behind the saved deltaLink
    messages.get('f-inbox')!.push({ ...messages.get('f-inbox')![0]!, id: 'f-inbox-new', subject: 'Inbox new', internetMessageId: '<new@src.test>' });
    fake.fail('GET', /\/messages\/delta$/, { status: 410 });
    h.newPass();
    await h.run(new MailEngine());
    expectEachOnce(created.map((c) => c.subject), ['Inbox 0', 'Inbox 1', 'Inbox 2', 'Inbox new']);
  });

  it('finishes the pass when a source folder is deleted mid-migration', async () => {
    const { messages, created } = mailTenant(fake, [
      { id: 'f-inbox', name: 'Inbox', wellKnown: 'inbox', messages: 2 },
      { id: 'f-gone', name: 'Gone', messages: 2 },
    ]);
    const h = new EngineHarness(FULL);
    const engine = new MailEngine();
    await h.tick(engine); // init
    await h.tick(engine); // folders: both queued
    messages.delete('f-gone'); // deleted at the source before its scan runs
    await h.run(engine);
    expect(created.map((c) => c.subject)).toEqual(['Inbox 0', 'Inbox 1']);
  });
});

describe('large mail attachments', () => {
  const MB = 1024 * 1024;
  /** Byte-for-byte equality (vitest's deep toEqual is far too slow for megabytes). */
  const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
  const run = async (big: { size: number; content: number; ignoresRange?: boolean }) => {
    const t = mailTenant(fake, [{ id: 'f-inbox', name: 'Inbox', wellKnown: 'inbox', messages: 1, bigAttachment: { 0: big } }]);
    const h = new EngineHarness(FULL);
    await h.run(new MailEngine());
    return { ...t, h };
  };

  it('uploads every chunk (Outlook acknowledges intermediate chunks with 200)', async () => {
    const { created, uploads, uploaded, h } = await run({ size: 10 * MB, content: 10 * MB });
    expect(created[0]!.attachments).toEqual(['big.bin']);
    expect(sameBytes(uploaded(uploads[0]!), attachmentBytes(10 * MB))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('sizes the upload session by the real content length, not the metadata size', async () => {
    // Graph's metadata size can exceed the content (its own docs show 3,640,066 vs 3,483,322)
    const { created, uploads, uploaded } = await run({ size: 4_500_000, content: 4_200_000 });
    expect(uploads[0]!.declared).toBe(4_200_000);
    expect(created[0]!.attachments).toEqual(['big.bin']);
    expect(sameBytes(uploaded(uploads[0]!), attachmentBytes(4_200_000))).toBe(true);
  });

  it('copies correctly when the source ignores Range requests', async () => {
    const { created, uploads, uploaded } = await run({ size: 9 * MB, content: 9 * MB, ignoresRange: true });
    expect(created[0]!.attachments).toEqual(['big.bin']);
    expect(sameBytes(uploaded(uploads[0]!), attachmentBytes(9 * MB))).toBe(true);
  });
});

describe('drive engine', () => {
  const MB = 1024 * 1024;
  const flat = (n: number, size = 10): DriveTree => ({
    folders: [],
    files: range(n).map((i) => ({ id: `f${i}`, name: `file${i}.txt`, parent: 'root', size })),
  });
  const docs = (): DriveTree => ({
    folders: [
      { id: 'fd', name: 'Docs', parent: 'root' },
      { id: 'fr', name: 'Reports', parent: 'fd' },
      { id: 'fp', name: 'Photos', parent: 'root' },
    ],
    files: [
      { id: 'a', name: 'a.txt', parent: 'fd', size: 10 },
      { id: 'q1', name: 'q1.txt', parent: 'fr', size: 10 },
      { id: 'top', name: 'top.txt', parent: 'root', size: 10 },
      { id: 'p', name: 'p.jpg', parent: 'fp', size: 10 },
    ],
  });

  it('does not lose queued files when a pass stops mid-page', async () => {
    const tree = flat(150);
    const { uploads } = driveTenant(fake, tree); // delta pages of 100, 25 files per tick
    const h = new EngineHarness(FULL);
    await h.run(new DriveEngine(), { until: () => uploads.length >= 40 });
    h.newPass();
    await h.run(new DriveEngine());
    expectEachOnce(uploads, tree.files.map((f) => f.name));
  });

  it('copies a file that failed on the next pass', async () => {
    const tree = flat(4);
    const { uploads } = driveTenant(fake, tree);
    fake.fail('PUT', /file2\.txt:\/content$/, { times: 2 }); // the client's one retry fails too
    const h = new EngineHarness(FULL);
    await h.run(new DriveEngine());
    expect(uploads.sort()).toEqual(['file0.txt', 'file1.txt', 'file3.txt']);
    expect(h.stats.drive).toMatchObject({ migrated: 3, failed: 1 });
    h.newPass();
    await h.run(new DriveEngine());
    expectEachOnce(uploads, tree.files.map((f) => f.name));
    expect(h.stats.drive).toMatchObject({ migrated: 1, failed: 0 });
  });

  it('re-enumerates when the delta token has expired', async () => {
    const tree = flat(3);
    const { uploads } = driveTenant(fake, tree);
    const h = new EngineHarness(FULL);
    await h.run(new DriveEngine());
    tree.files.push({ id: 'f-new', name: 'new.txt', parent: 'root', size: 10 });
    fake.fail('GET', /^\/drives\/src-drive\/root\/delta$/, { status: 410 });
    h.newPass();
    await h.run(new DriveEngine());
    expectEachOnce(uploads, tree.files.map((f) => f.name));
  });

  it('continues an upload whose chunk was stored but whose response was lost', async () => {
    const { uploads } = driveTenant(fake, { folders: [], files: [{ id: 'b', name: 'big.bin', parent: 'root', size: 25 * MB }] }, {
      loseResponseToPut: 2,
    });
    const h = new EngineHarness(FULL);
    await h.run(new DriveEngine());
    expect(uploads).toEqual(['big.bin']);
    expect(h.errors).toEqual([]);
  });

  it('re-copies a large file whose upload was interrupted by a stopped pass', async () => {
    const tree: DriveTree = {
      folders: [],
      files: [
        { id: 's', name: 'small.txt', parent: 'root', size: 10 },
        { id: 'b', name: 'big.bin', parent: 'root', size: 25 * MB }, // three 10 MiB chunks
      ],
    };
    const { uploads, destFiles } = driveTenant(fake, tree, { parentsFirst: true });
    fake.throttle('PUT', /^upload\.test\/s0$/, { after: 1 }); // first chunk lands, second is throttled
    const h = new EngineHarness(FULL);
    const engine = new DriveEngine();
    let outcome;
    for (let i = 0; i < 10 && outcome !== 'throttled'; i++) outcome = await h.tick(engine);
    expect(outcome).toBe('throttled');
    expect(uploads).toEqual(['small.txt']);
    // the pass is stopped mid-upload, then a new pass starts
    h.newPass();
    await h.run(engine);
    expect(destFiles()).toEqual(['big.bin', 'small.txt']);
    expect(h.errors).toEqual([]);
  });

  describe('folder structure (delta results carry no paths)', () => {
    it('puts every file in its folder, even when files are listed before their folders', async () => {
      const { destFiles } = driveTenant(fake, docs());
      const h = new EngineHarness(FULL);
      await h.run(new DriveEngine());
      expect(destFiles()).toEqual(['Docs/Reports/q1.txt', 'Docs/a.txt', 'Photos/p.jpg', 'top.txt']);
    });

    it('keeps same-named files in different folders apart', async () => {
      const { destFiles } = driveTenant(fake, {
        folders: [
          { id: 'fa', name: 'A', parent: 'root' },
          { id: 'fb', name: 'B', parent: 'root' },
        ],
        files: [
          { id: 'ra', name: 'report.txt', parent: 'fa', size: 10 },
          { id: 'rb', name: 'report.txt', parent: 'fb', size: 10 },
        ],
      });
      const h = new EngineHarness(FULL);
      await h.run(new DriveEngine());
      expect(destFiles()).toEqual(['A/report.txt', 'B/report.txt']);
    });

    it('excludes folders by path', async () => {
      const { destFiles } = driveTenant(fake, docs());
      const h = new EngineHarness({ ...FULL, filters: { driveExcludePaths: ['docs/reports'] } });
      await h.run(new DriveEngine());
      expect(destFiles()).toEqual(['Docs/a.txt', 'Photos/p.jpg', 'top.txt']);
    });

    it('renames the destination folder when the source folder is renamed', async () => {
      const { tree, changes, uploads, destFiles } = driveTenant(fake, docs());
      const h = new EngineHarness(FULL);
      await h.run(new DriveEngine());
      // delta reports only the renamed folder, not its contents
      tree.folders.find((f) => f.id === 'fd')!.name = 'Documents';
      tree.files.push({ id: 'b', name: 'b.txt', parent: 'fd', size: 10 });
      changes.push('fd', 'b');
      h.newPass({ ...FULL, passType: 'delta' });
      await h.run(new DriveEngine());
      expect(destFiles()).toEqual([
        'Documents/Reports/q1.txt',
        'Documents/a.txt',
        'Documents/b.txt',
        'Photos/p.jpg',
        'top.txt',
      ]);
      expect(uploads.filter((n) => n === 'a.txt')).toHaveLength(1);
    });

    it('moves the destination file when the source file is moved', async () => {
      const { tree, changes, uploads, destFiles } = driveTenant(fake, docs());
      const h = new EngineHarness(FULL);
      await h.run(new DriveEngine());
      tree.files.find((f) => f.id === 'a')!.parent = 'fp';
      changes.push('a');
      h.newPass({ ...FULL, passType: 'delta' });
      await h.run(new DriveEngine());
      expect(destFiles()).toEqual(['Docs/Reports/q1.txt', 'Photos/a.txt', 'Photos/p.jpg', 'top.txt']);
      expect(uploads.filter((n) => n === 'a.txt')).toHaveLength(1); // moved, not uploaded again
    });

    it('recreates a destination folder that was deleted and copies new files into it', async () => {
      const { tree, changes, destFiles, deleteDest, destIdOf } = driveTenant(fake, docs());
      const h = new EngineHarness(FULL);
      await h.run(new DriveEngine());
      deleteDest(destIdOf('Docs')!);
      tree.files.push({ id: 'n', name: 'new.txt', parent: 'fd', size: 10 });
      changes.push('n');
      h.newPass({ ...FULL, passType: 'delta' });
      await h.run(new DriveEngine());
      expect(destFiles()).toContain('Docs/new.txt');
      expect(h.stats.drive).toMatchObject({ migrated: 1, failed: 0, skipped: 0 });
    });

    it('recreates a whole deleted folder chain for a new file deep inside it', async () => {
      const { tree, changes, destFiles, deleteDest, destIdOf } = driveTenant(fake, docs());
      const h = new EngineHarness(FULL);
      await h.run(new DriveEngine());
      deleteDest(destIdOf('Docs')!); // takes Docs/Reports with it
      tree.files.push({ id: 'n', name: 'new.txt', parent: 'fr', size: 10 });
      changes.push('n');
      h.newPass({ ...FULL, passType: 'delta' });
      await h.run(new DriveEngine());
      expect(destFiles()).toContain('Docs/Reports/new.txt');
      expect(h.stats.drive).toMatchObject({ migrated: 1, failed: 0 });
    });

    it('re-copies nested files that older versions put at the root, and keeps true root files', async () => {
      const { uploads, destFiles } = driveTenant(fake, docs());
      const h = new EngineHarness(FULL);
      // id-map entries written by the path-based version ("<destId>|<cTag>")
      for (const id of ['a', 'q1', 'p', 'top']) h.store.mapPut('drive', 'item', id, `old-${id}|ctag-${id}`);
      await h.run(new DriveEngine());
      expect(uploads.sort()).toEqual(['a.txt', 'p.jpg', 'q1.txt']); // top.txt was already in the right place
      expect(destFiles()).toEqual(['Docs/Reports/q1.txt', 'Docs/a.txt', 'Photos/p.jpg']);
    });
  });
});
