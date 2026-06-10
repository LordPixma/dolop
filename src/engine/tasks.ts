// Microsoft To Do task migration engine. The default list maps to the
// destination default; other lists are find-or-created by display name.
// Note: app-only access to the To Do API (Tasks.ReadWrite.All application
// permission) is rejected by some tenants — a 403 here marks the workload
// complete with a clear item error instead of failing the whole user.

import { GraphError } from '../graph/client';
import type { TodoTask, TodoTaskList } from '../graph/types';
import { buildTaskPayload } from './transform';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'tasks';

interface ScanWork {
  srcListId: string;
  destListId: string;
  name: string;
}

export class TasksEngine implements WorkloadEngine {
  readonly name = 'tasks';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'lists';
    try {
      if (phase === 'lists') return await this.lists(ctx);
      return await this.items(ctx);
    } catch (e) {
      if (e instanceof GraphError && e.status === 403) {
        ctx.report.itemError(W, {
          itemType: 'workload',
          code: 'access_denied',
          message:
            'To Do API rejected app-only access (Tasks.ReadWrite.All). Verify the application ' +
            'permission is granted with admin consent in both tenants; some tenants do not ' +
            'support app-only To Do access. Workload skipped.',
        });
        ctx.report.stat(W, 'failed');
        return 'done';
      }
      throw e;
    }
  }

  private async lists(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest, report } = ctx;
    const [srcLists, dstLists] = await Promise.all([
      source.listAll<TodoTaskList>(`${ctx.sourceUserPath}/todo/lists?$top=100`),
      dest.listAll<TodoTaskList>(`${ctx.destUserPath}/todo/lists?$top=100`),
    ]);
    const dstDefault = dstLists.find((l) => l.wellknownListName === 'defaultList');
    const dstByName = new Map(dstLists.map((l) => [(l.displayName ?? '').toLowerCase(), l.id]));

    for (const list of srcLists) {
      if (list.wellknownListName === 'flaggedEmails') continue; // system-generated view
      let destId = store.mapGet(W, 'list', list.id);
      if (!destId) {
        if (list.wellknownListName === 'defaultList' && dstDefault) {
          destId = dstDefault.id;
        } else {
          destId = dstByName.get((list.displayName ?? '').toLowerCase()) ?? null;
          if (!destId) {
            try {
              const created = await dest.post<TodoTaskList>(`${ctx.destUserPath}/todo/lists`, {
                displayName: list.displayName ?? 'Migrated tasks',
              });
              destId = created.id;
            } catch (e) {
              if (e instanceof GraphError && e.name !== 'GraphThrottleError' && e.status !== 403) {
                report.itemError(W, {
                  itemType: 'taskList',
                  itemId: list.id,
                  itemName: list.displayName,
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
        store.mapPut(W, 'list', list.id, destId);
      }
      store.pushWork(W, 'scan', {
        srcListId: list.id,
        destListId: destId,
        name: list.displayName ?? '',
      } satisfies ScanWork);
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
        store.getState<string>(W, `next:${scan.srcListId}`) ??
        `${ctx.sourceUserPath}/todo/lists/${scan.srcListId}/tasks?$expand=checklistItems&$top=25`;
      const page = await source.page<TodoTask>(url, 25);

      for (const task of page.items) {
        if (ctx.budget.exhausted) break;
        report.stat(W, 'discovered');
        if (store.mapGet(W, 'item', task.id)) {
          report.stat(W, 'skipped');
          ctx.budget.itemDone();
          continue;
        }
        try {
          const created = await dest.post<{ id: string }>(
            `${ctx.destUserPath}/todo/lists/${scan.destListId}/tasks`,
            buildTaskPayload(task)
          );
          for (const item of task.checklistItems ?? []) {
            await dest
              .post(`${ctx.destUserPath}/todo/lists/${scan.destListId}/tasks/${created.id}/checklistItems`, {
                displayName: item.displayName ?? '',
                isChecked: item.isChecked ?? false,
              })
              .catch(() => {
                report.itemError(W, {
                  itemType: 'checklistItem',
                  itemId: task.id,
                  itemName: task.title,
                  code: 'checklist_failed',
                  message: 'task migrated but a checklist item failed to copy',
                });
              });
          }
          store.mapPut(W, 'item', task.id, created.id);
          report.stat(W, 'migrated');
          ctx.budget.itemDone();
        } catch (e) {
          if (e instanceof GraphError && e.name !== 'GraphThrottleError' && e.status !== 403) {
            report.itemError(W, {
              itemType: 'task',
              itemId: task.id,
              itemName: task.title,
              code: e.code,
              message: e.message,
            });
            report.stat(W, 'failed');
            store.mapPut(W, 'item', task.id, 'failed');
            ctx.budget.itemDone();
            continue;
          }
          throw e;
        }
      }

      if (page.nextLink) {
        store.setState(W, `next:${scan.srcListId}`, page.nextLink);
      } else {
        store.delState(W, `next:${scan.srcListId}`);
        store.popWork(work.id);
      }
    }
    return 'continue';
  }
}
