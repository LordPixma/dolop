// Outlook configuration engine: master categories, inbox rules (with folder-id
// remapping through the mail folder map — run the mail workload first so the
// map is populated), and mailbox settings (auto-replies, time zone, working
// hours, locale, date/time formats).

import { GraphError } from '../graph/client';
import type { MailboxSettings, MessageRule, OutlookCategory } from '../graph/types';
import { buildRulePayload } from './transform';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'rules';

export class RulesEngine implements WorkloadEngine {
  readonly name = 'rules';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'categories';
    if (phase === 'categories') {
      await this.categories(ctx);
      ctx.store.setPhase(W, 'rules');
      return 'continue';
    }
    if (phase === 'rules') {
      await this.rules(ctx);
      ctx.store.setPhase(W, 'settings');
      return 'continue';
    }
    await this.settings(ctx);
    return 'done';
  }

  private async categories(ctx: MigrationContext): Promise<void> {
    const { source, dest, report } = ctx;
    const [srcCats, dstCats] = await Promise.all([
      source.listAll<OutlookCategory>(`${ctx.sourceUserPath}/outlook/masterCategories?$top=100`),
      dest.listAll<OutlookCategory>(`${ctx.destUserPath}/outlook/masterCategories?$top=100`),
    ]);
    const existing = new Set(dstCats.map((c) => (c.displayName ?? '').toLowerCase()));
    for (const cat of srcCats) {
      report.stat(W, 'discovered');
      if (!cat.displayName || existing.has(cat.displayName.toLowerCase())) {
        report.stat(W, 'skipped');
        continue;
      }
      try {
        await dest.post(`${ctx.destUserPath}/outlook/masterCategories`, {
          displayName: cat.displayName,
          color: cat.color ?? 'none',
        });
        report.stat(W, 'migrated');
      } catch (e) {
        if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
          report.itemError(W, {
            itemType: 'category',
            itemName: cat.displayName,
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

  private async rules(ctx: MigrationContext): Promise<void> {
    const { store, source, dest, report } = ctx;
    const [srcRules, dstRules] = await Promise.all([
      source.listAll<MessageRule>(`${ctx.sourceUserPath}/mailFolders/inbox/messageRules`),
      dest.listAll<MessageRule>(`${ctx.destUserPath}/mailFolders/inbox/messageRules`),
    ]);
    const existing = new Set(dstRules.map((r) => (r.displayName ?? '').toLowerCase()));
    for (const rule of srcRules) {
      report.stat(W, 'discovered');
      if (rule.displayName && existing.has(rule.displayName.toLowerCase())) {
        report.stat(W, 'skipped');
        continue;
      }
      const payload = buildRulePayload(rule, (srcFolderId) => {
        const mapped = store.mapGet('mail', 'folder', srcFolderId);
        return mapped ?? undefined;
      });
      if (!payload) {
        report.itemError(W, {
          itemType: 'inboxRule',
          itemId: rule.id,
          itemName: rule.displayName,
          code: 'folder_not_mapped',
          message:
            'rule moves/copies mail into a folder that has not been migrated — run the mail ' +
            'workload first, then retry with a delta pass',
        });
        report.stat(W, 'failed');
        continue;
      }
      try {
        await dest.post(`${ctx.destUserPath}/mailFolders/inbox/messageRules`, payload);
        report.stat(W, 'migrated');
      } catch (e) {
        if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
          report.itemError(W, {
            itemType: 'inboxRule',
            itemId: rule.id,
            itemName: rule.displayName,
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

  private async settings(ctx: MigrationContext): Promise<void> {
    const { source, dest, report } = ctx;
    try {
      const s = await source.get<MailboxSettings>(`${ctx.sourceUserPath}/mailboxSettings`);
      const patch: Record<string, unknown> = {};
      if (s.automaticRepliesSetting) patch.automaticRepliesSetting = s.automaticRepliesSetting;
      if (s.timeZone) patch.timeZone = s.timeZone;
      if (s.language?.locale) patch.language = { locale: s.language.locale };
      if (s.workingHours) patch.workingHours = s.workingHours;
      if (s.dateFormat) patch.dateFormat = s.dateFormat;
      if (s.timeFormat) patch.timeFormat = s.timeFormat;
      report.stat(W, 'discovered');
      if (Object.keys(patch).length > 0) {
        await dest.patch(`${ctx.destUserPath}/mailboxSettings`, patch);
      }
      report.stat(W, 'migrated');
    } catch (e) {
      if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        report.itemError(W, {
          itemType: 'mailboxSettings',
          code: e.code,
          message: e.message,
        });
        report.stat(W, 'failed');
        return;
      }
      throw e;
    }
  }
}
