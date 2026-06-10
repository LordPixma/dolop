// Pre-migration assessment: sizes the source mailbox (folder item counts) and
// OneDrive usage, and verifies the destination user exists and has a mailbox
// (i.e. is licensed). Results land in per-user stats under assessment_* keys —
// nothing is written to the destination tenant.

import { GraphError } from '../graph/client';
import type { GraphDrive, GraphUser, MailFolder } from '../graph/types';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'assessment';

interface EnumWork {
  srcFolderId: string | null;
}

export class AssessmentEngine implements WorkloadEngine {
  readonly name = 'assessment';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'init';
    if (phase === 'init') {
      ctx.store.pushWork(W, 'enum', { srcFolderId: null } satisfies EnumWork);
      ctx.store.setPhase(W, 'mail');
      return 'continue';
    }
    if (phase === 'mail') return this.mail(ctx);
    if (phase === 'drive') return this.drive(ctx);
    return this.destChecks(ctx);
  }

  private async mail(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, report } = ctx;
    while (!ctx.budget.exhausted) {
      const work = store.peekWork<EnumWork>(W, 'enum');
      if (!work) {
        store.setPhase(W, 'drive');
        return 'continue';
      }
      const listPath = work.payload.srcFolderId
        ? `${ctx.sourceUserPath}/mailFolders/${work.payload.srcFolderId}/childFolders`
        : `${ctx.sourceUserPath}/mailFolders`;
      try {
        const folders = await source.listAll<MailFolder>(`${listPath}?$top=200`);
        for (const f of folders) {
          report.stat('assessment_mail', 'discovered', f.totalItemCount);
          if (f.childFolderCount > 0) {
            store.pushWork(W, 'enum', { srcFolderId: f.id } satisfies EnumWork);
          }
        }
      } catch (e) {
        if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
          report.itemError(W, { itemType: 'mailbox', code: e.code, message: e.message });
          report.stat('assessment_mail', 'failed');
        } else {
          throw e;
        }
      }
      store.popWork(work.id);
      ctx.budget.itemDone();
    }
    return 'continue';
  }

  private async drive(ctx: MigrationContext): Promise<StepResult> {
    const { source, report } = ctx;
    try {
      const drive = await source.get<GraphDrive>(`${ctx.sourceUserPath}/drive`);
      report.bytes('assessment_drive', drive.quota?.used ?? 0);
      report.stat('assessment_drive', 'discovered');
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        // no OneDrive provisioned — nothing to migrate
      } else if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        report.itemError(W, { itemType: 'drive', code: e.code, message: e.message });
      } else {
        throw e;
      }
    }
    ctx.store.setPhase(W, 'dest');
    return 'continue';
  }

  private async destChecks(ctx: MigrationContext): Promise<StepResult> {
    const { dest, report } = ctx;
    try {
      await dest.get<GraphUser>(`${ctx.destUserPath}?$select=id,userPrincipalName,accountEnabled`);
      report.stat('assessment_provision', 'migrated'); // destination user exists
      try {
        await dest.get(`${ctx.destUserPath}/mailFolders/inbox?$select=id`);
        report.stat('assessment_mailbox', 'migrated'); // destination mailbox is live
      } catch (e) {
        if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
          report.stat('assessment_mailbox', 'failed');
          report.itemError(W, {
            itemType: 'dest-mailbox',
            code: 'dest_mailbox_missing',
            message:
              'destination user exists but has no mailbox — assign an Exchange Online license ' +
              'before migrating',
          });
        } else {
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        report.stat('assessment_provision', 'failed');
        report.itemError(W, {
          itemType: 'dest-user',
          code: 'dest_user_missing',
          message: 'destination user does not exist — provision it from the Users page first',
        });
      } else if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        report.itemError(W, { itemType: 'dest-user', code: e.code, message: e.message });
      } else {
        throw e;
      }
    }
    return 'done';
  }
}
