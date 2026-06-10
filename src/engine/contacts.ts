// Contacts migration engine: default contacts folder plus named contact
// folders (find-or-create by display name), with id-map dedupe across passes.

import { GraphError } from '../graph/client';
import type { GraphContact, GraphContactFolder } from '../graph/types';
import { buildContactPayload } from './transform';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'contacts';

interface ScanWork {
  srcPath: string; // collection path relative to user, e.g. "/contacts"
  destPath: string;
  name: string;
}

export class ContactsEngine implements WorkloadEngine {
  readonly name = 'contacts';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'folders';
    if (phase === 'folders') return this.folders(ctx);
    return this.items(ctx);
  }

  private async folders(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest, report } = ctx;
    store.pushWork(W, 'scan', { srcPath: '/contacts', destPath: '/contacts', name: 'Contacts' } satisfies ScanWork);

    const [srcFolders, dstFolders] = await Promise.all([
      source.listAll<GraphContactFolder>(`${ctx.sourceUserPath}/contactFolders?$top=100`),
      dest.listAll<GraphContactFolder>(`${ctx.destUserPath}/contactFolders?$top=100`),
    ]);
    const dstByName = new Map(dstFolders.map((f) => [(f.displayName ?? '').toLowerCase(), f.id]));

    for (const f of srcFolders) {
      let destId = store.mapGet(W, 'folder', f.id);
      if (!destId) {
        destId = dstByName.get((f.displayName ?? '').toLowerCase()) ?? null;
        if (!destId) {
          try {
            const created = await dest.post<GraphContactFolder>(`${ctx.destUserPath}/contactFolders`, {
              displayName: f.displayName ?? 'Migrated contacts',
            });
            destId = created.id;
          } catch (e) {
            if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
              report.itemError(W, {
                itemType: 'contactFolder',
                itemId: f.id,
                itemName: f.displayName,
                code: e.code,
                message: e.message,
              });
              report.stat(W, 'failed');
              continue;
            }
            throw e;
          }
        }
        store.mapPut(W, 'folder', f.id, destId);
      }
      store.pushWork(W, 'scan', {
        srcPath: `/contactFolders/${f.id}/contacts`,
        destPath: `/contactFolders/${destId}/contacts`,
        name: f.displayName ?? '',
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
        store.getState<string>(W, `next:${scan.srcPath}`) ??
        `${ctx.sourceUserPath}${scan.srcPath}?$top=50`;
      const page = await source.page<GraphContact>(url, 50);

      for (const contact of page.items) {
        if (ctx.budget.exhausted) break;
        report.stat(W, 'discovered');
        if (store.mapGet(W, 'item', contact.id)) {
          report.stat(W, 'skipped');
          ctx.budget.itemDone();
          continue;
        }
        try {
          const created = await dest.post<{ id: string }>(
            `${ctx.destUserPath}${scan.destPath}`,
            buildContactPayload(contact)
          );
          store.mapPut(W, 'item', contact.id, created.id);
          report.stat(W, 'migrated');
          ctx.budget.itemDone();
        } catch (e) {
          if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
            report.itemError(W, {
              itemType: 'contact',
              itemId: contact.id,
              itemName: contact.displayName,
              code: e.code,
              message: e.message,
            });
            report.stat(W, 'failed');
            store.mapPut(W, 'item', contact.id, 'failed');
            ctx.budget.itemDone();
            continue;
          }
          throw e;
        }
      }

      if (page.nextLink) {
        store.setState(W, `next:${scan.srcPath}`, page.nextLink);
      } else {
        store.delState(W, `next:${scan.srcPath}`);
        store.popWork(work.id);
      }
    }
    return 'continue';
  }
}
