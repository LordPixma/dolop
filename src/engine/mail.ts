// Mail migration engine.
//
// Phase "folders": resolve well-known folders on both sides, walk the source
// folder tree breadth-first, find-or-create matching destination folders, and
// queue per-folder item scans.
//
// Phase "items": per folder, walk a Graph delta feed (cursor persisted per
// folder + filter signature, so later passes only see new/changed mail), fetch
// each message in full, recreate it in the destination folder with MAPI
// extended properties that preserve read state and timestamps, then copy
// attachments (upload sessions for large ones). The id map makes every pass
// idempotent.

import { GraphError } from '../graph/client';
import type { GraphAttachment, GraphMessage, MailFolder } from '../graph/types';
import {
  isPathExcluded,
  filterSignature,
  LARGE_ATTACHMENT_THRESHOLD,
  MAIL_ATTACHMENT_CHUNK_SIZE,
  nextChunkRange,
} from '../util';
import { buildMessagePayload } from './transform';
import { putUploadChunk } from './upload';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'mail';
const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive', 'outbox'] as const;

const MSG_SELECT =
  '$select=id,subject,body,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,' +
  'receivedDateTime,sentDateTime,isRead,isDraft,importance,categories,internetMessageId,hasAttachments,flag';

interface EnumWork {
  srcFolderId: string | null; // null = top level
  destParentId: string | null;
  path: string;
}

interface ScanWork {
  srcFolderId: string;
  destFolderId: string;
  path: string;
  asDraft: boolean;
}

interface FolderCursor {
  url: string;
  isDelta: boolean;
}

interface AttachmentResume {
  srcMsgId: string;
  destMsgId: string;
  remaining: { id: string; name?: string; size: number }[];
  /** in-flight large attachment upload */
  upload?: { attId: string; sessionUrl: string; offset: number; size: number; name?: string };
  /** set when this resume is replaying a queued attachment repair */
  retry?: boolean;
  workId?: number;
  tries?: number;
}

/** A failed attachment copy queued for replay on a later tick or pass. */
interface AttRetryWork {
  srcMsgId: string;
  destMsgId: string;
  attId: string;
  name?: string;
  size: number;
  tries: number;
}

const MAX_ATTACHMENT_TRIES = 3;

export class MailEngine implements WorkloadEngine {
  readonly name = 'mail';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'init';
    if (phase === 'init') return this.init(ctx);
    if (phase === 'folders') return this.folders(ctx);
    return this.items(ctx);
  }

  private async init(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest } = ctx;
    const srcWk: Record<string, string> = {};
    const dstWk: Record<string, string> = {};
    for (const name of WELL_KNOWN) {
      try {
        const f = await source.get<MailFolder>(`${ctx.sourceUserPath}/mailFolders/${name}`);
        srcWk[name] = f.id;
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 404)) throw e;
      }
      try {
        const f = await dest.get<MailFolder>(`${ctx.destUserPath}/mailFolders/${name}`);
        dstWk[name] = f.id;
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 404)) throw e;
      }
    }
    store.setState(W, 'wkSrc', srcWk);
    store.setState(W, 'wkDst', dstWk);
    store.pushWork(W, 'enum', { srcFolderId: null, destParentId: null, path: '' } satisfies EnumWork);
    store.setPhase(W, 'folders');
    return 'continue';
  }

  private async folders(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest, report } = ctx;
    const srcWk = store.getState<Record<string, string>>(W, 'wkSrc') ?? {};
    const dstWk = store.getState<Record<string, string>>(W, 'wkDst') ?? {};
    const srcWkById = new Map(Object.entries(srcWk).map(([name, id]) => [id, name]));

    while (!ctx.budget.exhausted) {
      const work = store.peekWork<EnumWork>(W, 'enum');
      if (!work) {
        store.setPhase(W, 'items');
        return 'continue';
      }
      const { srcFolderId, destParentId, path } = work.payload;
      const listPath = srcFolderId
        ? `${ctx.sourceUserPath}/mailFolders/${srcFolderId}/childFolders`
        : `${ctx.sourceUserPath}/mailFolders`;
      const children = await source.listAll<MailFolder>(`${listPath}?$top=200`);

      for (const child of children) {
        const childPath = path ? `${path}/${child.displayName}` : child.displayName;
        const wellKnownName = srcWkById.get(child.id);
        if (wellKnownName === 'outbox') continue; // transient; never migrated

        const excluded =
          isPathExcluded(childPath, ctx.pass.filters.excludeFolders) ||
          (ctx.pass.filters.excludeDeletedItems !== false && wellKnownName === 'deleteditems') ||
          (ctx.pass.filters.excludeJunk !== false && wellKnownName === 'junkemail');

        let destId = store.mapGet(W, 'folder', child.id);
        if (!destId && !excluded) {
          try {
            destId = await this.resolveDestFolder(ctx, child, wellKnownName, dstWk, destParentId);
            store.mapPut(W, 'folder', child.id, destId);
            store.mapPut(W, 'folderpath', child.id, childPath);
          } catch (e) {
            if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
              report.itemError(W, {
                itemType: 'folder',
                itemId: child.id,
                itemName: childPath,
                code: e.code,
                message: e.message,
              });
              report.stat(W, 'failed');
              continue;
            }
            throw e;
          }
        }
        if (child.childFolderCount > 0) {
          store.pushWork(W, 'enum', {
            srcFolderId: child.id,
            destParentId: destId,
            path: childPath,
          } satisfies EnumWork);
        }
        if (!excluded && destId) {
          store.pushWork(W, 'scan', {
            srcFolderId: child.id,
            destFolderId: destId,
            path: childPath,
            asDraft: wellKnownName === 'drafts',
          } satisfies ScanWork);
          // Folder item counts give progress bars a real denominator. Delta
          // passes only see new items, so the full count would mislead there.
          if (ctx.pass.passType !== 'delta') {
            ctx.report.expected(W, child.totalItemCount);
          }
        }
      }
      store.popWork(work.id);
    }
    return 'continue';
  }

  private async resolveDestFolder(
    ctx: MigrationContext,
    child: MailFolder,
    wellKnownName: string | undefined,
    dstWk: Record<string, string>,
    destParentId: string | null
  ): Promise<string> {
    if (wellKnownName && dstWk[wellKnownName]) return dstWk[wellKnownName];
    const createPath = destParentId
      ? `${ctx.destUserPath}/mailFolders/${destParentId}/childFolders`
      : `${ctx.destUserPath}/mailFolders`;
    try {
      const created = await ctx.dest.post<MailFolder>(createPath, { displayName: child.displayName });
      return created.id;
    } catch (e) {
      if (e instanceof GraphError && (e.code === 'ErrorFolderExists' || e.status === 409)) {
        const name = child.displayName.replace(/'/g, "''");
        const existing = await ctx.dest.listAll<MailFolder>(
          `${createPath}?$filter=displayName eq '${encodeURIComponent(name)}'`
        );
        const match = existing[0];
        if (match) return match.id;
      }
      throw e;
    }
  }

  private deltaCursorKey(srcFolderId: string, filters: MigrationContext['pass']['filters']): string {
    return `delta:${srcFolderId}:${filterSignature(filters)}`;
  }

  private initialDeltaUrl(ctx: MigrationContext, srcFolderId: string): string {
    const filters: string[] = [];
    if (ctx.pass.filters.mailReceivedBefore) {
      filters.push(`receivedDateTime le ${ctx.pass.filters.mailReceivedBefore}`);
    }
    if (ctx.pass.filters.mailReceivedAfter) {
      filters.push(`receivedDateTime ge ${ctx.pass.filters.mailReceivedAfter}`);
    }
    let url = `${ctx.sourceUserPath}/mailFolders/${srcFolderId}/messages/delta?$select=id,receivedDateTime`;
    if (filters.length) url += `&$filter=${encodeURIComponent(filters.join(' and '))}`;
    return url;
  }

  private async items(ctx: MigrationContext): Promise<StepResult> {
    const { store } = ctx;
    while (!ctx.budget.exhausted) {
      // Resume an interrupted attachment copy before anything else.
      const att = store.getState<AttachmentResume>(W, 'att');
      if (att) {
        await this.copyAttachments(ctx, att);
        if (att.retry) {
          store.delState(W, 'att');
          if (att.workId !== undefined) store.popWork(att.workId);
          ctx.budget.itemDone();
        } else {
          this.finishMessage(ctx, att.srcMsgId, att.destMsgId);
        }
        continue;
      }

      // Replay queued attachment repairs (failures from earlier ticks/passes).
      const retryWork = store.peekWork<AttRetryWork>(W, 'attretry');
      if (retryWork) {
        const r = retryWork.payload;
        store.setState(W, 'att', {
          srcMsgId: r.srcMsgId,
          destMsgId: r.destMsgId,
          remaining: [{ id: r.attId, name: r.name, size: r.size }],
          retry: true,
          workId: retryWork.id,
          tries: r.tries,
        } satisfies AttachmentResume);
        continue;
      }

      const work = store.peekWork<ScanWork>(W, 'scan');
      if (!work) return 'done';
      const scan = work.payload;
      const cursorKey = this.deltaCursorKey(scan.srcFolderId, ctx.pass.filters);

      const pending = store.getState<string[]>(W, 'pending') ?? [];
      if (pending.length > 0) {
        await this.migrateOne(ctx, scan, pending);
        continue;
      }

      // Fetch the next delta page for this folder.
      let cursor = store.getJson<FolderCursor>(`cursor:${W}:${cursorKey}`);
      const folderDone = store.getState<boolean>(W, `pageDone:${scan.srcFolderId}`);
      if (folderDone) {
        store.delState(W, `pageDone:${scan.srcFolderId}`);
        store.popWork(work.id);
        continue;
      }
      const url = cursor?.url ?? this.initialDeltaUrl(ctx, scan.srcFolderId);
      const page = await ctx.source.page<GraphMessage>(url, 40);
      const ids = page.items.filter((m) => !m['@removed']).map((m) => m.id);
      ctx.report.stat(W, 'discovered', ids.length);
      store.setState(W, 'pending', ids);
      if (page.deltaLink) {
        store.setJson(`cursor:${W}:${cursorKey}`, { url: page.deltaLink, isDelta: true } satisfies FolderCursor);
        store.setState(W, `pageDone:${scan.srcFolderId}`, true);
      } else if (page.nextLink) {
        store.setJson(`cursor:${W}:${cursorKey}`, { url: page.nextLink, isDelta: false } satisfies FolderCursor);
      } else {
        store.setState(W, `pageDone:${scan.srcFolderId}`, true);
      }
    }
    return 'continue';
  }

  private finishMessage(ctx: MigrationContext, srcMsgId: string, destMsgId: string): void {
    ctx.store.mapPut(W, 'item', srcMsgId, destMsgId);
    ctx.store.delState(W, 'att');
    const pending = ctx.store.getState<string[]>(W, 'pending') ?? [];
    if (pending[0] === srcMsgId) {
      pending.shift();
      ctx.store.setState(W, 'pending', pending);
    }
    ctx.report.stat(W, 'migrated');
    ctx.budget.itemDone();
  }

  private async migrateOne(ctx: MigrationContext, scan: ScanWork, pending: string[]): Promise<void> {
    const { store, source, dest, report } = ctx;
    const msgId = pending[0];
    if (!msgId) return;
    const skip = () => {
      pending.shift();
      store.setState(W, 'pending', pending);
      ctx.budget.itemDone();
    };

    if (store.mapGet(W, 'item', msgId)) {
      report.stat(W, 'skipped');
      skip();
      return;
    }

    let msg: GraphMessage;
    try {
      msg = await source.get<GraphMessage>(`${ctx.sourceUserPath}/messages/${msgId}?${MSG_SELECT}`);
    } catch (e) {
      if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        if (e.status === 404) {
          // deleted at source since enumeration
          report.stat(W, 'skipped');
        } else {
          report.itemError(W, { itemType: 'message', itemId: msgId, code: e.code, message: e.message });
          report.stat(W, 'failed');
        }
        skip();
        return;
      }
      throw e;
    }

    // Defense-in-depth date filtering (the delta query already filters).
    const recv = msg.receivedDateTime;
    const { mailReceivedBefore, mailReceivedAfter } = ctx.pass.filters;
    if (recv && ((mailReceivedBefore && recv > mailReceivedBefore) || (mailReceivedAfter && recv < mailReceivedAfter))) {
      report.stat(W, 'skipped');
      skip();
      return;
    }

    // Optional convergence net: if the destination already holds this message
    // (matched by Internet Message-ID), map it instead of duplicating. When the
    // existing copy is missing its attachments (e.g. a pre-fix failure), queue
    // them for repair.
    if (ctx.pass.filters.mailDedupeByMessageId && msg.internetMessageId) {
      try {
        const safe = msg.internetMessageId.replace(/'/g, "''");
        const found = await dest.get<{ value: { id: string; hasAttachments?: boolean }[] }>(
          `${ctx.destUserPath}/messages?$filter=${encodeURIComponent(
            `internetMessageId eq '${safe}'`
          )}&$select=id,hasAttachments&$top=1`
        );
        const hit = found.value?.[0];
        if (hit) {
          store.mapPut(W, 'item', msgId, hit.id);
          if (msg.hasAttachments && !hit.hasAttachments) {
            const list = await source.get<{ value: GraphAttachment[] }>(
              `${ctx.sourceUserPath}/messages/${msgId}/attachments?$select=id,name,contentType,size,isInline`
            );
            for (const a of list.value ?? []) {
              store.pushWork(W, 'attretry', {
                srcMsgId: msgId,
                destMsgId: hit.id,
                attId: a.id,
                name: a.name,
                size: a.size ?? 0,
                tries: 0,
              } satisfies AttRetryWork);
            }
          }
          report.stat(W, 'skipped');
          skip();
          return;
        }
      } catch {
        // dedupe is best-effort — fall through and create the message
      }
    }

    const asDraft = scan.asDraft || msg.isDraft === true;
    try {
      const created = await dest.post<{ id: string }>(
        `${ctx.destUserPath}/mailFolders/${scan.destFolderId}/messages`,
        buildMessagePayload(msg, { asDraft })
      );
      ctx.report.bytes(W, msg.body?.content?.length ?? 0);
      if (msg.hasAttachments) {
        const list = await source.get<{ value: GraphAttachment[] }>(
          `${ctx.sourceUserPath}/messages/${msgId}/attachments?$select=id,name,contentType,size,isInline`
        );
        const att: AttachmentResume = {
          srcMsgId: msgId,
          destMsgId: created.id,
          remaining: (list.value ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size ?? 0 })),
        };
        store.setState(W, 'att', att);
        await this.copyAttachments(ctx, att);
      }
      this.finishMessage(ctx, msgId, created.id);
    } catch (e) {
      if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        report.itemError(W, {
          itemType: 'message',
          itemId: msgId,
          itemName: msg.subject,
          code: e.code,
          message: e.message,
        });
        report.stat(W, 'failed');
        store.delState(W, 'att');
        skip();
        return;
      }
      throw e; // throttle → orchestrator pauses; attachment state resumes next tick
    }
  }

  /**
   * Record a failed attachment for replay (up to MAX_ATTACHMENT_TRIES across
   * ticks/passes — the queue survives pass resets). Only after the final
   * attempt does it count against the user's failed-item stats.
   */
  private queueAttachmentRetry(
    ctx: MigrationContext,
    att: AttachmentResume,
    a: { id: string; name?: string; size: number },
    code: string,
    message: string
  ): void {
    const tries = (att.tries ?? 0) + 1;
    const final = tries >= MAX_ATTACHMENT_TRIES;
    ctx.report.itemError(W, {
      itemType: 'attachment',
      itemId: a.id,
      itemName: a.name,
      code,
      message: final
        ? `${message} (giving up after ${tries} attempts)`
        : `${message} (queued for retry, attempt ${tries}/${MAX_ATTACHMENT_TRIES})`,
    });
    if (final) {
      ctx.report.stat(W, 'failed');
      return;
    }
    ctx.store.pushWork(W, 'attretry', {
      srcMsgId: att.srcMsgId,
      destMsgId: att.destMsgId,
      attId: a.id,
      name: a.name,
      size: a.size,
      tries,
    } satisfies AttRetryWork);
  }

  private async copyAttachments(ctx: MigrationContext, att: AttachmentResume): Promise<void> {
    const { store, source, dest, report } = ctx;

    while (att.upload || att.remaining.length > 0) {
      if (att.upload) {
        const up = att.upload;
        // Outlook upload sessions cap chunks at 4 MB (OneDrive allows more).
        const range = nextChunkRange(up.offset, up.size, MAIL_ATTACHMENT_CHUNK_SIZE);
        if (!range) {
          att.upload = undefined;
          store.setState(W, 'att', att);
          continue;
        }
        try {
          const res = await source.requestRaw(
            'GET',
            `${ctx.sourceUserPath}/messages/${att.srcMsgId}/attachments/${up.attId}/$value`,
            { headers: { range: `bytes=${range.start}-${range.end}` } }
          );
          let bytes = await res.arrayBuffer();
          if (res.status === 200 && bytes.byteLength > range.length) {
            // source ignored the Range header and returned the full content
            bytes = bytes.slice(range.start, range.end + 1);
          }
          const result = await putUploadChunk(up.sessionUrl, bytes, range.start, range.end, up.size);
          up.offset = range.end + 1;
          report.bytes(W, range.length);
          if (result.done || up.offset >= up.size) att.upload = undefined;
          store.setState(W, 'att', att);
        } catch (e) {
          if (!(e instanceof GraphError) || e.name === 'GraphThrottleError') throw e;
          this.queueAttachmentRetry(
            ctx,
            att,
            { id: up.attId, name: up.name, size: up.size },
            e.code,
            e.message
          );
          att.upload = undefined;
          store.setState(W, 'att', att);
        }
        continue;
      }

      const next = att.remaining[0];
      if (!next) break;
      try {
        if (next.size > LARGE_ATTACHMENT_THRESHOLD) {
          const session = await dest.post<{ uploadUrl: string }>(
            `${ctx.destUserPath}/messages/${att.destMsgId}/attachments/createUploadSession`,
            {
              AttachmentItem: {
                attachmentType: 'file',
                name: next.name ?? 'attachment',
                size: next.size,
              },
            }
          );
          att.upload = { attId: next.id, sessionUrl: session.uploadUrl, offset: 0, size: next.size, name: next.name };
          att.remaining.shift();
          store.setState(W, 'att', att);
          continue;
        }
        const full = await source.get<GraphAttachment>(
          `${ctx.sourceUserPath}/messages/${att.srcMsgId}/attachments/${next.id}`
        );
        const odataType = full['@odata.type'] ?? '#microsoft.graph.fileAttachment';
        if (odataType === '#microsoft.graph.fileAttachment' && full.contentBytes !== undefined) {
          await dest.post(`${ctx.destUserPath}/messages/${att.destMsgId}/attachments`, {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: full.name ?? 'attachment',
            contentType: full.contentType,
            contentBytes: full.contentBytes,
            isInline: full.isInline ?? false,
            contentId: full.contentId,
          });
          report.bytes(W, next.size);
        } else {
          // itemAttachment / referenceAttachment cannot be copied with full
          // fidelity app-only; record so the operator can review.
          report.itemError(W, {
            itemType: 'attachment',
            itemId: next.id,
            itemName: next.name,
            code: 'unsupported_attachment_type',
            message: `attachment type ${odataType} on message ${att.srcMsgId} was not copied`,
          });
        }
        att.remaining.shift();
        store.setState(W, 'att', att);
      } catch (e) {
        if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
          this.queueAttachmentRetry(ctx, att, next, e.code, e.message);
          att.upload = undefined;
          att.remaining.shift();
          store.setState(W, 'att', att);
          continue;
        }
        throw e;
      }
    }
  }
}
