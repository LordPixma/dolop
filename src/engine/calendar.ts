// Calendar migration engine.
//
// Maps the default calendar to the destination default and find-or-creates
// secondary calendars by name, then copies single-instance events and series
// masters (recurrence rules regenerate occurrences in the destination).
// By default attendees are stripped so Exchange Online never sends meeting
// invitations during migration; the original attendee list and organizer are
// preserved in a com.dolop.migration open extension on each event.

import { GraphError } from '../graph/client';
import type { GraphCalendar, GraphEvent } from '../graph/types';
import { drainPages } from './paged';
import { buildEventPayload } from './transform';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'calendar';

const EVENT_SELECT =
  '$select=id,subject,body,start,end,location,attendees,organizer,recurrence,isAllDay,isCancelled,' +
  'sensitivity,showAs,importance,categories,reminderMinutesBeforeStart,isReminderOn,type';

interface ScanWork {
  srcCalId: string;
  destCalId: string;
  name: string;
}

/** A created event whose attendee extension is still to be written (e.g. paused by throttling). */
interface ExtensionResume {
  srcEventId: string;
  destEventId: string;
}

export class CalendarEngine implements WorkloadEngine {
  readonly name = 'calendar';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'calendars';
    if (phase === 'calendars') return this.calendars(ctx);
    return this.items(ctx);
  }

  private async calendars(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest, report } = ctx;
    const [srcDefault, dstDefault, srcCals, dstCals] = await Promise.all([
      source.get<GraphCalendar>(`${ctx.sourceUserPath}/calendar`),
      dest.get<GraphCalendar>(`${ctx.destUserPath}/calendar`),
      source.listAll<GraphCalendar>(`${ctx.sourceUserPath}/calendars?$top=100`),
      dest.listAll<GraphCalendar>(`${ctx.destUserPath}/calendars?$top=100`),
    ]);
    const dstByName = new Map(dstCals.map((c) => [(c.name ?? '').toLowerCase(), c.id]));

    // Scans are queued only once every calendar is resolved, so a throttle
    // part-way through (which re-runs this phase) can't queue one twice.
    const scans: ScanWork[] = [];
    for (const cal of srcCals) {
      let destId = store.mapGet(W, 'cal', cal.id);
      if (!destId) {
        if (cal.id === srcDefault.id || cal.isDefaultCalendar) {
          destId = dstDefault.id;
        } else {
          destId = dstByName.get((cal.name ?? '').toLowerCase()) ?? null;
          if (!destId) {
            try {
              const created = await dest.post<GraphCalendar>(`${ctx.destUserPath}/calendars`, {
                name: cal.name ?? 'Migrated calendar',
              });
              destId = created.id;
            } catch (e) {
              if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
                report.itemError(W, {
                  itemType: 'calendar',
                  itemId: cal.id,
                  itemName: cal.name,
                  code: e.code,
                  message: e.message,
                });
                report.stat(W, 'failed');
                continue;
              }
              throw e;
            }
          }
        }
        store.mapPut(W, 'cal', cal.id, destId);
      }
      scans.push({ srcCalId: cal.id, destCalId: destId, name: cal.name ?? '' });
    }
    for (const s of scans) store.pushWork(W, 'scan', s);
    store.setPhase(W, 'items');
    return 'continue';
  }

  private async items(ctx: MigrationContext): Promise<StepResult> {
    const { store } = ctx;
    while (!ctx.budget.exhausted) {
      const work = store.peekWork<ScanWork>(W, 'scan');
      if (!work) return 'done';
      const scan = work.payload;
      const finished = await drainPages<GraphEvent>(
        ctx,
        W,
        {
          key: scan.srcCalId,
          firstUrl: `${ctx.sourceUserPath}/calendars/${scan.srcCalId}/events?${EVENT_SELECT}`,
          pageSize: 25,
        },
        (ev) => this.copyEvent(ctx, scan, ev)
      );
      if (finished) store.popWork(work.id);
    }
    return 'continue';
  }

  private async copyEvent(ctx: MigrationContext, scan: ScanWork, ev: GraphEvent): Promise<void> {
    const { store, dest, report } = ctx;
    if (ev.isCancelled || ev.type === 'occurrence' || ev.type === 'exception') return;
    const resume = store.getCarry<ExtensionResume>(W, 'extension');
    if (resume?.srcEventId === ev.id) {
      const { strippedAttendees } = buildEventPayload(ev, { attendeeMode: 'strip' });
      await this.writeAttendeeExtension(ctx, ev, resume.destEventId, strippedAttendees ?? []);
      report.stat(W, 'migrated');
      ctx.budget.itemDone();
      return;
    }
    report.stat(W, 'discovered');
    if (store.mapGet(W, 'item', ev.id)) {
      report.stat(W, 'skipped'); // no Graph call, so it doesn't count against the tick's item budget
      return;
    }
    try {
      const { payload, strippedAttendees } = buildEventPayload(ev, {
        attendeeMode: ctx.pass.filters.calendarAttendees ?? 'strip',
      });
      const created = await dest.post<{ id: string }>(
        `${ctx.destUserPath}/calendars/${scan.destCalId}/events`,
        payload
      );
      // Mapped straight away so a throttle on the extension resumes this
      // event (via the carried marker) instead of creating it again.
      store.mapPut(W, 'item', ev.id, created.id);
      if (strippedAttendees) {
        store.setCarry(W, 'extension', { srcEventId: ev.id, destEventId: created.id } satisfies ExtensionResume);
        await this.writeAttendeeExtension(ctx, ev, created.id, strippedAttendees);
      }
      report.stat(W, 'migrated');
    } catch (e) {
      if (!(e instanceof GraphError) || e.name === 'GraphThrottleError') throw e;
      report.itemError(W, {
        itemType: 'event',
        itemId: ev.id,
        itemName: ev.subject,
        code: e.code,
        message: e.message,
      });
      report.stat(W, 'failed'); // left unmapped, so the next pass retries it
    }
    ctx.budget.itemDone();
  }

  /** Preserve the stripped attendee list on the destination event; a throttle pauses and retries. */
  private async writeAttendeeExtension(
    ctx: MigrationContext,
    ev: GraphEvent,
    destEventId: string,
    attendees: unknown[]
  ): Promise<void> {
    try {
      await ctx.dest.post(`${ctx.destUserPath}/events/${destEventId}/extensions`, {
        '@odata.type': 'microsoft.graph.openTypeExtension',
        extensionName: 'com.dolop.migration',
        originalAttendees: JSON.stringify(attendees).slice(0, 30_000),
        originalOrganizer: JSON.stringify(ev.organizer ?? null),
      });
    } catch (e) {
      if (!(e instanceof GraphError) || e.name === 'GraphThrottleError') throw e;
      ctx.report.itemError(W, {
        itemType: 'event-extension',
        itemId: ev.id,
        itemName: ev.subject,
        code: e.code,
        message: `event migrated but its original attendee list could not be stored: ${e.message}`,
      });
    }
    ctx.store.delCarry(W, 'extension');
  }
}
