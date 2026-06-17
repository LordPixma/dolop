// Pure payload builders: convert source Graph resources into destination
// create-payloads. Kept free of I/O so fidelity rules are unit-testable.

import type {
  GraphContact,
  GraphEvent,
  GraphMessage,
  MessageRule,
  TodoTask,
} from '../graph/types';

// MAPI extended properties used to import mail with correct flags/timestamps.
// PR_MESSAGE_FLAGS (0x0E07): clearing MSGFLAG_UNSENT makes the imported item a
// normal received message instead of a draft; bit 0 marks it read.
const PR_MESSAGE_FLAGS = 'Integer 0x0E07';
const PR_MESSAGE_DELIVERY_TIME = 'SystemTime 0x0E06';
const PR_CLIENT_SUBMIT_TIME = 'SystemTime 0x0039';

export function buildMessagePayload(
  msg: GraphMessage,
  opts: { asDraft: boolean }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    subject: msg.subject ?? '',
    body: {
      contentType: msg.body?.contentType ?? 'html',
      content: msg.body?.content ?? '',
    },
    toRecipients: msg.toRecipients ?? [],
    ccRecipients: msg.ccRecipients ?? [],
    bccRecipients: msg.bccRecipients ?? [],
    replyTo: msg.replyTo ?? [],
    importance: msg.importance ?? 'normal',
    categories: msg.categories ?? [],
    isRead: msg.isRead ?? true,
  };
  if (msg.from?.emailAddress?.address) payload.from = msg.from;
  if (msg.sender?.emailAddress?.address) payload.sender = msg.sender;
  if (msg.internetMessageId) payload.internetMessageId = msg.internetMessageId;
  if (msg.flag?.flagStatus && msg.flag.flagStatus !== 'notFlagged') {
    payload.flag = { flagStatus: msg.flag.flagStatus };
  }

  if (!opts.asDraft) {
    const props: { id: string; value: string }[] = [
      // MSGFLAG_READ (1) when read; 0 otherwise. Crucially, MSGFLAG_UNSENT is
      // NOT set, so the destination item is a received message, not a draft.
      { id: PR_MESSAGE_FLAGS, value: msg.isRead === false ? '0' : '1' },
    ];
    if (msg.receivedDateTime) {
      payload.receivedDateTime = msg.receivedDateTime;
      props.push({ id: PR_MESSAGE_DELIVERY_TIME, value: msg.receivedDateTime });
    }
    if (msg.sentDateTime) {
      payload.sentDateTime = msg.sentDateTime;
      props.push({ id: PR_CLIENT_SUBMIT_TIME, value: msg.sentDateTime });
    }
    payload.singleValueExtendedProperties = props;
  }
  return payload;
}

export function buildEventPayload(
  ev: GraphEvent,
  opts: { attendeeMode: 'strip' | 'preserve' }
): { payload: Record<string, unknown>; strippedAttendees: unknown[] | null } {
  const payload: Record<string, unknown> = {
    subject: ev.subject ?? '',
    body: {
      contentType: ev.body?.contentType ?? 'html',
      content: ev.body?.content ?? '',
    },
    start: ev.start,
    end: ev.end,
    isAllDay: ev.isAllDay ?? false,
    sensitivity: ev.sensitivity ?? 'normal',
    showAs: ev.showAs ?? 'busy',
    importance: ev.importance ?? 'normal',
    categories: ev.categories ?? [],
    isReminderOn: ev.isReminderOn ?? false,
    responseRequested: false,
  };
  if (ev.location?.displayName) payload.location = { displayName: ev.location.displayName };
  if (ev.recurrence) payload.recurrence = ev.recurrence;
  if (typeof ev.reminderMinutesBeforeStart === 'number') {
    payload.reminderMinutesBeforeStart = ev.reminderMinutesBeforeStart;
  }

  let strippedAttendees: unknown[] | null = null;
  const attendees = ev.attendees ?? [];
  if (attendees.length > 0) {
    if (opts.attendeeMode === 'preserve') {
      payload.attendees = attendees;
    } else {
      strippedAttendees = attendees;
    }
  }
  return { payload, strippedAttendees };
}

export function buildContactPayload(c: GraphContact): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const copy = <K extends keyof GraphContact>(k: K) => {
    const v = c[k];
    if (v !== undefined && v !== null) payload[k as string] = v;
  };
  copy('givenName');
  copy('middleName');
  copy('surname');
  copy('nickName');
  copy('title');
  copy('jobTitle');
  copy('companyName');
  copy('department');
  copy('officeLocation');
  copy('emailAddresses');
  copy('businessPhones');
  copy('homePhones');
  copy('mobilePhone');
  copy('businessAddress');
  copy('homeAddress');
  copy('otherAddress');
  copy('birthday');
  copy('personalNotes');
  copy('categories');
  copy('imAddresses');
  copy('fileAs');
  // emailAddresses entries sometimes carry read-only odata annotations; strip to name/address.
  if (Array.isArray(payload.emailAddresses)) {
    payload.emailAddresses = (payload.emailAddresses as { name?: string; address?: string }[]).map(
      (e) => ({ name: e.name, address: e.address })
    );
  }
  return payload;
}

export function buildTaskPayload(t: TodoTask): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: t.title ?? '(untitled task)',
    status: t.status ?? 'notStarted',
    importance: t.importance ?? 'normal',
  };
  if (t.body?.content) payload.body = { content: t.body.content, contentType: t.body.contentType ?? 'text' };
  if (t.dueDateTime) payload.dueDateTime = t.dueDateTime;
  if (t.startDateTime) payload.startDateTime = t.startDateTime;
  if (t.completedDateTime) payload.completedDateTime = t.completedDateTime;
  if (t.reminderDateTime) payload.reminderDateTime = t.reminderDateTime;
  if (t.isReminderOn !== undefined) payload.isReminderOn = t.isReminderOn;
  if (t.recurrence) payload.recurrence = t.recurrence;
  if (t.categories?.length) payload.categories = t.categories;
  return payload;
}

/**
 * Display name of the managed coexistence forwarding rule. Kept distinct so it
 * can be found for update/teardown and skipped by the rules-migration engine
 * (it must never be copied between mailboxes, or the copy would forward to the
 * wrong tenant and risk a loop).
 */
export const COEXISTENCE_RULE_NAME = 'Dolop Coexistence (do not delete)';

/**
 * Build the managed inbox rule that forwards a copy of all incoming mail to the
 * counterpart mailbox. `forwardTo` keeps the original in this mailbox and sends
 * a copy onward, so mail is received in both tenants. The rule applies to every
 * message (no conditions) and does not stop other rules from running.
 */
export function buildCoexistenceRule(forwardAddress: string): Record<string, unknown> {
  return {
    displayName: COEXISTENCE_RULE_NAME,
    sequence: 1,
    isEnabled: true,
    conditions: {},
    exceptions: {},
    actions: {
      forwardTo: [{ emailAddress: { address: forwardAddress } }],
      stopProcessingRules: false,
    },
  };
}

/**
 * Rewrite folder-id references in an inbox rule using the mail folder map.
 * Returns null when the rule references a folder that was not migrated
 * (the rule cannot be recreated faithfully).
 */
export function buildRulePayload(
  rule: MessageRule,
  mapFolderId: (sourceFolderId: string) => string | undefined
): Record<string, unknown> | null {
  const actions = { ...(rule.actions ?? {}) } as Record<string, unknown>;
  for (const key of ['moveToFolder', 'copyToFolder'] as const) {
    const src = actions[key];
    if (typeof src === 'string' && src) {
      const mapped = mapFolderId(src);
      if (!mapped) return null;
      actions[key] = mapped;
    }
  }
  return {
    displayName: rule.displayName ?? 'Migrated rule',
    sequence: rule.sequence ?? 100,
    isEnabled: rule.isEnabled ?? true,
    conditions: rule.conditions ?? {},
    exceptions: rule.exceptions ?? {},
    actions,
  };
}
