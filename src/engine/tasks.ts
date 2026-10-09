// Microsoft To Do task migration engine. The default list maps to the
// destination default; other lists are find-or-created by display name.
// Note: app-only access to the To Do API (Tasks.ReadWrite.All application
// permission) is rejected by some tenants — a 403 here marks the workload
// complete with a clear item error instead of failing the whole user.

import { GraphError } from '../graph/client';
import type { TodoTask, TodoTaskList } from '../graph/types';
import { drainPages } from './paged';
import { buildTaskPayload } from './transform';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'tasks';

interface ScanWork {
  srcListId: string;
  destListId: string;
  name: string;
}

/** A created task whose checklist is part-way copied (e.g. paused by throttling). */
interface ChecklistResume {
  srcTaskId: string;
  destTaskId: string;
  /** Checklist items already handled. */
  done: number;
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

    // Scans are queued only once every list is resolved, so a throttle
    // part-way through (which re-runs this phase) can't queue one twice.
    const scans: ScanWork[] = [];
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
      scans.push({ srcListId: list.id, destListId: destId, name: list.displayName ?? '' });
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
      const finished = await drainPages<TodoTask>(
        ctx,
        W,
        {
          key: scan.srcListId,
          firstUrl: `${ctx.sourceUserPath}/todo/lists/${scan.srcListId}/tasks?$expand=checklistItems&$top=25`,
          pageSize: 25,
        },
        (task) => this.copyTask(ctx, scan, task)
      );
      if (finished) store.popWork(work.id);
    }
    return 'continue';
  }

  private async copyTask(ctx: MigrationContext, scan: ScanWork, task: TodoTask): Promise<void> {
    const { store, dest, report } = ctx;
    const resume = store.getCarry<ChecklistResume>(W, 'checklist');
    if (resume?.srcTaskId === task.id) {
      await this.copyChecklist(ctx, scan, task, resume);
      report.stat(W, 'migrated');
      ctx.budget.itemDone();
      return;
    }
    report.stat(W, 'discovered');
    if (store.mapGet(W, 'item', task.id)) {
      report.stat(W, 'skipped'); // no Graph call, so it doesn't count against the tick's item budget
      return;
    }
    try {
      const created = await dest.post<{ id: string }>(
        `${ctx.destUserPath}/todo/lists/${scan.destListId}/tasks`,
        buildTaskPayload(task)
      );
      // Mapped straight away so a throttle mid-checklist resumes this task
      // (via the carried checklist position) instead of creating it again.
      store.mapPut(W, 'item', task.id, created.id);
      if (task.checklistItems?.length) {
        const checklist: ChecklistResume = { srcTaskId: task.id, destTaskId: created.id, done: 0 };
        store.setCarry(W, 'checklist', checklist);
        await this.copyChecklist(ctx, scan, task, checklist);
      }
      report.stat(W, 'migrated');
    } catch (e) {
      if (!(e instanceof GraphError) || e.name === 'GraphThrottleError' || e.status === 403) throw e;
      report.itemError(W, {
        itemType: 'task',
        itemId: task.id,
        itemName: task.title,
        code: e.code,
        message: e.message,
      });
      report.stat(W, 'failed'); // left unmapped, so the next pass retries it
    }
    ctx.budget.itemDone();
  }

  /** Copy a task's checklist from the carried position; a throttle pauses with the position saved. */
  private async copyChecklist(
    ctx: MigrationContext,
    scan: ScanWork,
    task: TodoTask,
    resume: ChecklistResume
  ): Promise<void> {
    const { store, dest, report } = ctx;
    const items = task.checklistItems ?? [];
    for (; resume.done < items.length; resume.done++) {
      const item = items[resume.done]!;
      try {
        await dest.post(
          `${ctx.destUserPath}/todo/lists/${scan.destListId}/tasks/${resume.destTaskId}/checklistItems`,
          { displayName: item.displayName ?? '', isChecked: item.isChecked ?? false }
        );
      } catch (e) {
        if (!(e instanceof GraphError) || e.name === 'GraphThrottleError') throw e;
        report.itemError(W, {
          itemType: 'checklistItem',
          itemId: task.id,
          itemName: task.title,
          code: e.code,
          message: `task migrated but checklist item "${item.displayName ?? ''}" failed to copy: ${e.message}`,
        });
      }
      store.setCarry(W, 'checklist', { ...resume, done: resume.done + 1 });
    }
    store.delCarry(W, 'checklist');
  }
}
