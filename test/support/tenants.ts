// Fake source/destination tenants for engine tests, served through FakeGraph.
// Each builder registers the Graph routes one workload uses and returns the
// source fixtures plus records of what was created in the destination.

import type { GraphEvent, TodoTask } from '../../src/graph/types';
import { FakeGraph, json, pageOf, range } from './engine';

// ---------------------------------------------------------------------------
// Contacts

export function contactsTenant(fake: FakeGraph, opts: { defaultCount: number; folders?: { name: string; count: number }[] }) {
  const folders = (opts.folders ?? []).map((f, i) => ({ id: `cf${i}`, ...f }));
  const contacts = new Map<string, { id: string; givenName: string }[]>([
    ['default', range(opts.defaultCount).map((i) => ({ id: `c${i}`, givenName: `Contact ${i}` }))],
    ...folders.map((f) => [f.id, range(f.count).map((i) => ({ id: `${f.id}-c${i}`, givenName: `${f.name} ${i}` }))] as const),
  ]);
  const created: { folder: string; name: string }[] = [];
  const destFolders: string[] = [];
  fake
    .route('GET', /^\/users\/src\/contactFolders$/, () => json({ value: folders.map((f) => ({ id: f.id, displayName: f.name })) }))
    .route('GET', /^\/users\/dst\/contactFolders$/, () => json({ value: [] }))
    .route('POST', /^\/users\/dst\/contactFolders$/, (req) => {
      destFolders.push(req.body.displayName);
      return json({ id: `dcf-${req.body.displayName}` }, 201);
    })
    .route('GET', /^\/users\/src\/contacts$/, (req) => pageOf(contacts.get('default')!, req))
    .route('GET', /^\/users\/src\/contactFolders\/([^/]+)\/contacts$/, (req) => pageOf(contacts.get(req.m[1]!)!, req))
    .route('POST', /^\/users\/dst\/contacts$/, (req) => {
      created.push({ folder: 'default', name: req.body.givenName });
      return json({ id: `dc${created.length}` }, 201);
    })
    .route('POST', /^\/users\/dst\/contactFolders\/([^/]+)\/contacts$/, (req) => {
      created.push({ folder: req.m[1]!, name: req.body.givenName });
      return json({ id: `dc${created.length}` }, 201);
    });
  const all = [...contacts.values()].flat().map((c) => c.givenName);
  return { all, created, destFolders };
}

// ---------------------------------------------------------------------------
// Calendar

export function calendarTenant(
  fake: FakeGraph,
  calendars: { id: string; name: string; isDefault?: boolean; events: Partial<GraphEvent>[] }[]
) {
  const created: { calendar: string; subject: string; body: Record<string, any> }[] = [];
  const extensions: string[] = [];
  const destCalendars: string[] = [];
  const srcDefault = calendars.find((c) => c.isDefault)!;
  fake
    .route('GET', /^\/users\/src\/calendar$/, () => json({ id: srcDefault.id }))
    .route('GET', /^\/users\/dst\/calendar$/, () => json({ id: 'dcal-default' }))
    .route('GET', /^\/users\/src\/calendars$/, () =>
      json({ value: calendars.map((c) => ({ id: c.id, name: c.name, isDefaultCalendar: Boolean(c.isDefault) })) })
    )
    .route('GET', /^\/users\/dst\/calendars$/, () => json({ value: [{ id: 'dcal-default', name: 'Calendar' }] }))
    .route('POST', /^\/users\/dst\/calendars$/, (req) => {
      destCalendars.push(req.body.name);
      return json({ id: `dcal-${req.body.name}` }, 201);
    })
    .route('GET', /^\/users\/src\/calendars\/([^/]+)\/events$/, (req) =>
      pageOf(calendars.find((c) => c.id === req.m[1])!.events, req)
    )
    .route('POST', /^\/users\/dst\/calendars\/([^/]+)\/events$/, (req) => {
      created.push({ calendar: req.m[1]!, subject: req.body.subject, body: req.body });
      return json({ id: `de${created.length}` }, 201);
    })
    .route('POST', /^\/users\/dst\/events\/([^/]+)\/extensions$/, (req) => {
      extensions.push(req.m[1]!);
      return json({}, 201);
    });
  return { created, extensions, destCalendars };
}

export const event = (id: string, extra: Partial<GraphEvent> = {}): Partial<GraphEvent> => ({
  id,
  subject: `Event ${id}`,
  type: 'singleInstance',
  start: { dateTime: '2026-01-01T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-01-01T10:00:00.0000000', timeZone: 'UTC' },
  ...extra,
});

// ---------------------------------------------------------------------------
// To Do

export function tasksTenant(fake: FakeGraph, lists: { id: string; name: string; isDefault?: boolean; tasks: TodoTask[] }[]) {
  const created: { list: string; title: string; id: string }[] = [];
  const checklist: { task: string; name: string }[] = [];
  const destLists: string[] = [];
  fake
    .route('GET', /^\/users\/src\/todo\/lists$/, () =>
      json({
        value: lists.map((l) => ({ id: l.id, displayName: l.name, wellknownListName: l.isDefault ? 'defaultList' : 'none' })),
      })
    )
    .route('GET', /^\/users\/dst\/todo\/lists$/, () =>
      json({ value: [{ id: 'dl-default', displayName: 'Tasks', wellknownListName: 'defaultList' }] })
    )
    .route('POST', /^\/users\/dst\/todo\/lists$/, (req) => {
      destLists.push(req.body.displayName);
      return json({ id: `dl-${req.body.displayName}` }, 201);
    })
    .route('GET', /^\/users\/src\/todo\/lists\/([^/]+)\/tasks$/, (req) => pageOf(lists.find((l) => l.id === req.m[1])!.tasks, req))
    .route('POST', /^\/users\/dst\/todo\/lists\/([^/]+)\/tasks$/, (req) => {
      const id = `dt${created.length}`;
      created.push({ list: req.m[1]!, title: req.body.title, id });
      return json({ id }, 201);
    })
    .route('POST', /^\/users\/dst\/todo\/lists\/[^/]+\/tasks\/([^/]+)\/checklistItems$/, (req) => {
      checklist.push({ task: req.m[1]!, name: req.body.displayName });
      return json({}, 201);
    });
  return { created, checklist, destLists };
}

// ---------------------------------------------------------------------------
// Mail

const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive', 'outbox'];

export interface SrcMailFolder {
  id: string;
  name: string;
  wellKnown?: string;
  parent?: string;
  messages?: number;
  /** message index → number of small attachments */
  attachments?: Record<number, number>;
}

export interface SrcMessage {
  id: string;
  subject: string;
  receivedDateTime: string;
  body: { contentType: string; content: string };
  hasAttachments: boolean;
  internetMessageId: string;
}

export function mailTenant(fake: FakeGraph, folders: SrcMailFolder[]) {
  const messages = new Map<string, SrcMessage[]>();
  const attachmentCount = new Map<string, number>();
  for (const f of folders) {
    messages.set(
      f.id,
      range(f.messages ?? 0).map((i) => {
        const id = `${f.id}-m${i}`;
        attachmentCount.set(id, f.attachments?.[i] ?? 0);
        return {
          id,
          subject: `${f.name} ${i}`,
          receivedDateTime: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().replace('.000', ''),
          body: { contentType: 'text', content: 'hello' },
          hasAttachments: (f.attachments?.[i] ?? 0) > 0,
          internetMessageId: `<${id}@src.test>`,
        };
      })
    );
  }
  const allMessages = [...messages.values()].flat();
  const view = (f: SrcMailFolder) => ({
    id: f.id,
    displayName: f.name,
    childFolderCount: folders.filter((c) => c.parent === f.id).length,
    totalItemCount: f.messages ?? 0,
  });
  /** Destination folders: well-known ones exist up front; others are created. */
  const destFolders = new Map<string, { name: string; parent: string | null }>([
    ['d-inbox', { name: 'Inbox', parent: null }],
    ['d-deleteditems', { name: 'Deleted Items', parent: null }],
    ['d-drafts', { name: 'Drafts', parent: null }],
  ]);
  const created: { id: string; folder: string; subject: string; internetMessageId?: string; attachments: string[] }[] = [];
  const wk = WELL_KNOWN.join('|');
  fake
    .route('GET', new RegExp(`^/users/src/mailFolders/(${wk})$`), (req) => {
      const f = folders.find((x) => x.wellKnown === req.m[1]);
      return f ? json(view(f)) : json({ error: { code: 'ErrorItemNotFound' } }, 404);
    })
    .route('GET', new RegExp(`^/users/dst/mailFolders/(${wk})$`), (req) =>
      destFolders.has(`d-${req.m[1]}`) ? json({ id: `d-${req.m[1]}` }) : json({ error: { code: 'ErrorItemNotFound' } }, 404)
    )
    .route('GET', /^\/users\/src\/mailFolders$/, () => json({ value: folders.filter((f) => !f.parent).map(view) }))
    .route('GET', /^\/users\/src\/mailFolders\/([^/]+)\/childFolders$/, (req) =>
      json({ value: folders.filter((f) => f.parent === req.m[1]).map(view) })
    )
    .route('GET', /^\/users\/src\/mailFolders\/([^/]+)\/messages\/delta$/, (req) =>
      pageOf(
        (messages.get(req.m[1]!) ?? []).map((m) => ({ id: m.id, receivedDateTime: m.receivedDateTime })),
        req,
        { delta: true }
      )
    )
    .route('GET', /^\/users\/src\/messages\/([^/]+)\/attachments$/, (req) =>
      json({
        value: range(attachmentCount.get(req.m[1]!) ?? 0).map((j) => ({ id: `${req.m[1]}-a${j}`, name: `file${j}.txt`, size: 5 })),
      })
    )
    .route('GET', /^\/users\/src\/messages\/([^/]+)\/attachments\/([^/]+)$/, (req) =>
      json({ '@odata.type': '#microsoft.graph.fileAttachment', id: req.m[2], name: `${req.m[2]}.txt`, contentBytes: 'aGVsbG8=' })
    )
    .route('GET', /^\/users\/src\/messages\/([^/]+)$/, (req) => {
      const m = allMessages.find((x) => x.id === req.m[1]);
      return m ? json(m) : json({ error: { code: 'ErrorItemNotFound' } }, 404);
    })
    .route('POST', /^\/users\/dst\/mailFolders$/, (req) => {
      const id = `d-${req.body.displayName}`;
      destFolders.set(id, { name: req.body.displayName, parent: null });
      return json({ id }, 201);
    })
    .route('POST', /^\/users\/dst\/mailFolders\/([^/]+)\/childFolders$/, (req) => {
      const id = `d-${req.body.displayName}`;
      destFolders.set(id, { name: req.body.displayName, parent: req.m[1]! });
      return json({ id }, 201);
    })
    .route('POST', /^\/users\/dst\/mailFolders\/([^/]+)\/messages$/, (req) => {
      const id = `dm${created.length}`;
      created.push({ id, folder: req.m[1]!, subject: req.body.subject, internetMessageId: req.body.internetMessageId, attachments: [] });
      return json({ id }, 201);
    })
    // Message-ID dedupe lookup: $filter=internetMessageId eq '<…>'
    .route('GET', /^\/users\/dst\/messages$/, (req) => {
      const wanted = /internetMessageId eq '(.+)'/.exec(req.url.searchParams.get('$filter') ?? '')?.[1]?.replace(/''/g, "'");
      const hits = created.filter((c) => c.internetMessageId === wanted);
      return json({ value: hits.map((c) => ({ id: c.id, hasAttachments: c.attachments.length > 0 })) });
    })
    .route('POST', /^\/users\/dst\/messages\/([^/]+)\/attachments$/, (req) => {
      created.find((c) => c.id === req.m[1])!.attachments.push(req.body.name);
      return json({ id: 'att' }, 201);
    });
  return { messages, allMessages, created, destFolders };
}

/** A single inbox with `n` messages (and optional attachments per message index). */
export const mailbox = (fake: FakeGraph, n: number, attachments: Record<number, number> = {}) =>
  mailTenant(fake, [{ id: 'f-inbox', name: 'Inbox', wellKnown: 'inbox', messages: n, attachments }]);
