import { describe, expect, it } from 'vitest';
import {
  buildContactPayload,
  buildEventPayload,
  buildMessagePayload,
  buildRulePayload,
  buildTaskPayload,
} from '../src/engine/transform';
import type { GraphEvent, GraphMessage, MessageRule } from '../src/graph/types';

const baseMsg: GraphMessage = {
  id: 'm1',
  subject: 'Quarterly results',
  body: { contentType: 'html', content: '<p>hi</p>' },
  from: { emailAddress: { name: 'Ada', address: 'ada@contoso.com' } },
  toRecipients: [{ emailAddress: { address: 'bob@contoso.com' } }],
  receivedDateTime: '2024-03-01T10:00:00Z',
  sentDateTime: '2024-03-01T09:59:00Z',
  isRead: true,
  internetMessageId: '<abc@contoso.com>',
};

describe('buildMessagePayload', () => {
  it('imports a received message as non-draft with preserved timestamps', () => {
    const p = buildMessagePayload(baseMsg, { asDraft: false });
    expect(p.subject).toBe('Quarterly results');
    expect(p.receivedDateTime).toBe('2024-03-01T10:00:00Z');
    expect(p.internetMessageId).toBe('<abc@contoso.com>');
    const props = p.singleValueExtendedProperties as { id: string; value: string }[];
    const flags = props.find((x) => x.id.includes('0x0E07'))!;
    expect(flags.value).toBe('1'); // MSGFLAG_READ, not MSGFLAG_UNSENT → not a draft
    expect(props.some((x) => x.id.includes('0x0E06'))).toBe(true); // delivery time
    expect(props.some((x) => x.id.includes('0x0039'))).toBe(true); // submit time
  });

  it('marks unread messages unread without the unsent bit', () => {
    const p = buildMessagePayload({ ...baseMsg, isRead: false }, { asDraft: false });
    const props = p.singleValueExtendedProperties as { id: string; value: string }[];
    expect(props.find((x) => x.id.includes('0x0E07'))!.value).toBe('0');
    expect(p.isRead).toBe(false);
  });

  it('leaves drafts as drafts (no extended flag override)', () => {
    const p = buildMessagePayload(baseMsg, { asDraft: true });
    expect(p.singleValueExtendedProperties).toBeUndefined();
    expect(p.receivedDateTime).toBeUndefined();
  });
});

describe('buildEventPayload', () => {
  const event: GraphEvent = {
    id: 'e1',
    subject: 'Board meeting',
    start: { dateTime: '2024-05-01T09:00:00', timeZone: 'Europe/London' },
    end: { dateTime: '2024-05-01T10:00:00', timeZone: 'Europe/London' },
    attendees: [{ emailAddress: { address: 'cfo@contoso.com' }, type: 'required' }],
    recurrence: { pattern: { type: 'weekly' } },
  };

  it('strips attendees by default and returns them for archival', () => {
    const { payload, strippedAttendees } = buildEventPayload(event, { attendeeMode: 'strip' });
    expect(payload.attendees).toBeUndefined();
    expect(payload.responseRequested).toBe(false);
    expect(strippedAttendees).toHaveLength(1);
    expect(payload.recurrence).toEqual({ pattern: { type: 'weekly' } });
  });

  it('preserves attendees when configured', () => {
    const { payload, strippedAttendees } = buildEventPayload(event, { attendeeMode: 'preserve' });
    expect(payload.attendees).toHaveLength(1);
    expect(strippedAttendees).toBeNull();
  });
});

describe('buildRulePayload', () => {
  const rule: MessageRule = {
    id: 'r1',
    displayName: 'File invoices',
    sequence: 3,
    isEnabled: true,
    conditions: { subjectContains: ['invoice'] },
    actions: { moveToFolder: 'src-folder-1', markAsRead: true },
  };

  it('remaps folder ids through the mail folder map', () => {
    const p = buildRulePayload(rule, (id) => (id === 'src-folder-1' ? 'dst-folder-9' : undefined))!;
    expect((p.actions as Record<string, unknown>).moveToFolder).toBe('dst-folder-9');
    expect((p.actions as Record<string, unknown>).markAsRead).toBe(true);
    expect(p.displayName).toBe('File invoices');
  });

  it('returns null when a referenced folder was not migrated', () => {
    expect(buildRulePayload(rule, () => undefined)).toBeNull();
  });

  it('passes through rules without folder actions', () => {
    const p = buildRulePayload(
      { id: 'r2', displayName: 'Flag it', actions: { markImportance: 'high' } },
      () => undefined
    );
    expect(p).not.toBeNull();
  });
});

describe('buildContactPayload', () => {
  it('copies writable fields and sanitizes email addresses', () => {
    const p = buildContactPayload({
      id: 'c1',
      givenName: 'Ada',
      surname: 'Lovelace',
      emailAddresses: [{ name: 'Ada', address: 'ada@contoso.com' }],
      mobilePhone: '+44 1234',
      personalNotes: 'VIP',
    });
    expect(p.givenName).toBe('Ada');
    expect(p.emailAddresses).toEqual([{ name: 'Ada', address: 'ada@contoso.com' }]);
    expect(p.mobilePhone).toBe('+44 1234');
    expect('id' in p).toBe(false);
  });
});

describe('buildTaskPayload', () => {
  it('keeps status, dates and recurrence', () => {
    const p = buildTaskPayload({
      id: 't1',
      title: 'File the TSA',
      status: 'inProgress',
      importance: 'high',
      dueDateTime: { dateTime: '2024-06-01T00:00:00', timeZone: 'UTC' },
      recurrence: { pattern: { type: 'daily' } },
    });
    expect(p.title).toBe('File the TSA');
    expect(p.status).toBe('inProgress');
    expect(p.dueDateTime).toBeDefined();
    expect(p.recurrence).toBeDefined();
  });
});
