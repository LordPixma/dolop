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
      store.pushWork(W, 'scan', { srcCalId: cal.id, destCalId: destId, name: cal.name ?? '' } satisfies ScanWork);
    }
    store.setPhase(W, 'items');
    return 'continue';
  }

  private async items(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest, report } = ctx;
    while (!ctx.budget.exhausted) {
      const work = store.peekWork<ScanWork>(W, 'scan');
      if (!work) return 'done';
      const scan = work.payload;

      const url =
        store.getState<string>(W, `next:${scan.srcCalId}`) ??
        `${ctx.sourceUserPath}/calendars/${scan.srcCalId}/events?${EVENT_SELECT}`;
      const page = await source.page<GraphEvent>(url, 25);

      for (const ev of page.items) {
        if (ctx.budget.exhausted) break;
        if (ev.isCancelled || ev.type === 'occurrence' || ev.type === 'exception') continue;
        report.stat(W, 'discovered');
        if (store.mapGet(W, 'item', ev.id)) {
          report.stat(W, 'skipped');
          ctx.budget.itemDone();
          continue;
        }
        try {
          const { payload, strippedAttendees } = buildEventPayload(ev, {
            attendeeMode: ctx.pass.filters.calendarAttendees ?? 'strip',
          });
          const created = await dest.post<{ id: string }>(
            `${ctx.destUserPath}/calendars/${scan.destCalId}/events`,
            payload
          );
          if (strippedAttendees) {
            await dest
              .post(`${ctx.destUserPath}/events/${created.id}/extensions`, {
                '@odata.type': 'microsoft.graph.openTypeExtension',
                extensionName: 'com.dolop.migration',
                originalAttendees: JSON.stringify(strippedAttendees).slice(0, 30_000),
                originalOrganizer: JSON.stringify(ev.organizer ?? null),
              })
              .catch(() => {
                report.itemError(W, {
                  itemType: 'event-extension',
                  itemId: ev.id,
                  itemName: ev.subject,
                  code: 'extension_failed',
                  message: 'event migrated but original attendee list could not be stored',
                });
              });
          }
          store.mapPut(W, 'item', ev.id, created.id);
          report.stat(W, 'migrated');
          ctx.budget.itemDone();
        } catch (e) {
          if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
            report.itemError(W, {
              itemType: 'event',
              itemId: ev.id,
              itemName: ev.subject,
              code: e.code,
              message: e.message,
            });
            report.stat(W, 'failed');
            store.mapPut(W, 'item', ev.id, 'failed'); // don't retry forever within this pass
            ctx.budget.itemDone();
            continue;
          }
          throw e;
        }
      }

      if (page.nextLink) {
        store.setState(W, `next:${scan.srcCalId}`, page.nextLink);
      } else {
        store.delState(W, `next:${scan.srcCalId}`);
        store.popWork(work.id);
      }
    }
    return 'continue';
  }
}
