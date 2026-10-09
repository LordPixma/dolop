// OneDrive migration engine.
//
// Enumerates the source drive with the Graph delta feed (the persisted delta
// token makes later passes incremental) and copies files: ≤4 MB via direct
// upload, larger via resumable upload sessions streamed in 10 MiB chunks
// (range-read from the source download URL, chunk-PUT to the destination
// session — the file never has to fit in Worker memory). cTag comparison
// re-copies files whose content changed since the previous pass.
//
// Delta results never carry parentReference.path (renaming a folder doesn't
// return its descendants) and don't list parents before children, so
// everything is tracked by id, as Microsoft recommends: each source folder's
// name and parent are kept in the id map ('srcfolder'), unknown parents are
// looked up on demand, and destination folders are mapped by source folder
// id ('folder'). A folder renamed or moved at the source is renamed or moved
// in the destination, and so is a file whose content didn't change.

import { GraphError, GraphThrottleError } from '../graph/client';
import type { DriveItem, GraphDrive, UploadSession } from '../graph/types';
import { isPathExcluded, LARGE_FILE_THRESHOLD, nextChunkRange } from '../util';
import { putUploadChunk } from './upload';
import type { ItemErrorInput, MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'drive';

interface FileWork {
  srcId: string;
  /** Source parent folder id. */
  parentId: string;
  /** Relative path (for reporting only — placement goes by parentId). */
  path: string;
  name: string;
  size: number;
  downloadUrl?: string;
  cTag?: string;
  fsInfo?: { createdDateTime?: string; lastModifiedDateTime?: string };
  /** Failed attempts so far (set on fileretry work). */
  tries?: number;
  /** Pass in which the last attempt failed; retried only from the next one. */
  pass?: number;
}

interface UploadState extends FileWork {
  sessionUrl: string;
  offset: number;
}

/** Where the delta cursor moves once the current page's files are all copied. */
interface DeltaAdvance {
  /** The page's nextLink or deltaLink (absent when the feed returned neither). */
  cursor?: string;
  /** This was the last page of the enumeration. */
  last: boolean;
}

/** A source folder as last seen; parentId null = the drive root. */
interface SrcFolder {
  name: string;
  parentId: string | null;
}

/** The id-map value for a copied file: destination id, cTag, source parent and name. */
interface CopiedFile {
  d: string;
  c: string;
  p: string;
  n: string;
}

/**
 * Read a file's id-map entry. Entries written by the path-based version are
 * "<destId>|<cTag>" with no placement recorded (`legacy`).
 */
function readCopied(raw: string | null): (CopiedFile & { legacy?: false }) | { legacy: true; d: string; c: string } | null {
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw) as CopiedFile;
    } catch {
      return null;
    }
  }
  const [d = '', c = ''] = raw.split('|');
  return { legacy: true, d, c };
}

const copied = (destId: string, file: { cTag?: string; parentId: string; name: string }): string =>
  JSON.stringify({ d: destId, c: file.cTag ?? '', p: file.parentId, n: file.name } satisfies CopiedFile);

const MAX_FILE_TRIES = 3;

export class DriveEngine implements WorkloadEngine {
  readonly name = 'drive';

  async step(ctx: MigrationContext): Promise<StepResult> {
    const phase = ctx.store.getPhase(W) ?? 'init';
    if (phase === 'init') return this.init(ctx);
    return this.walk(ctx);
  }

  private async init(ctx: MigrationContext): Promise<StepResult> {
    const { store, source, dest, report } = ctx;
    let src: GraphDrive;
    try {
      src = await source.get<GraphDrive>(`${ctx.sourceUserPath}/drive`);
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        report.itemError(W, {
          itemType: 'drive',
          code: 'no_source_drive',
          message: 'source user has no OneDrive (never provisioned); workload skipped',
        });
        return 'done';
      }
      throw e;
    }
    let dst: GraphDrive;
    try {
      dst = await dest.get<GraphDrive>(`${ctx.destUserPath}/drive`);
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        report.itemError(W, {
          itemType: 'drive',
          code: 'no_dest_drive',
          message:
            'destination user has no OneDrive yet. OneDrive is provisioned on first use — ' +
            'have the user sign in once, or pre-provision via SharePoint admin, then run a delta pass.',
        });
        report.stat(W, 'failed');
        return 'done';
      }
      throw e;
    }
    store.setState(W, 'srcDriveId', src.id);
    store.setState(W, 'dstDriveId', dst.id);
    // Quota usage gives byte-level progress a real denominator (full passes
    // only — delta passes copy just the changes).
    if (ctx.pass.passType !== 'delta' && src.quota?.used) {
      report.expectedBytes(W, src.quota.used);
    }
    store.setPhase(W, 'walk');
    return 'continue';
  }

  private async walk(ctx: MigrationContext): Promise<StepResult> {
    const { store } = ctx;
    const srcDriveId = store.getState<string>(W, 'srcDriveId')!;
    const dstDriveId = store.getState<string>(W, 'dstDriveId')!;

    while (!ctx.budget.exhausted) {
      // 1. Continue an in-flight large upload.
      const upload = store.getState<UploadState>(W, 'upload');
      if (upload) {
        await this.continueUpload(ctx, srcDriveId, upload);
        continue;
      }
      // 2. Retry files that failed in an earlier pass. Retries queued by this
      //    pass sit behind them (higher ids), so they wait for the next pass.
      const retry = store.peekWork<FileWork>(W, 'fileretry');
      if (retry && (retry.payload.pass ?? 0) < store.passSeq) {
        await this.copyFile(ctx, srcDriveId, dstDriveId, retry.id, retry.payload);
        continue;
      }
      // 3. Copy the next queued file.
      const work = store.peekWork<FileWork>(W, 'file');
      if (work) {
        await this.copyFile(ctx, srcDriveId, dstDriveId, work.id, work.payload);
        continue;
      }
      // 4. The page's files are all copied: only now move the persisted delta
      //    cursor past it. Advancing on fetch would let a pass that stops
      //    mid-page lose its queued files and in-flight upload for good —
      //    resetPass() drops both but keeps cursors. Re-reading a page after
      //    a stop is safe: files copied with an unchanged cTag are skipped.
      const advance = store.getState<DeltaAdvance>(W, 'advance');
      if (advance) {
        if (advance.cursor) store.setCursor(W, 'delta', advance.cursor);
        store.delState(W, 'advance');
        if (advance.last) store.setState(W, 'enumDone', true);
        continue;
      }
      // 5. Advance delta enumeration.
      if (store.getState<boolean>(W, 'enumDone')) return 'done';
      await this.fetchDeltaPage(ctx, srcDriveId, dstDriveId);
    }
    return 'continue';
  }

  private async fetchDeltaPage(ctx: MigrationContext, srcDriveId: string, dstDriveId: string): Promise<void> {
    const { store, source, report } = ctx;
    const cursor = store.getCursor(W, 'delta');
    let page: { items: DriveItem[]; nextLink?: string; deltaLink?: string };
    try {
      page = await source.page<DriveItem>(cursor ?? `/drives/${srcDriveId}/root/delta`, 100);
    } catch (e) {
      if (
        cursor &&
        e instanceof GraphError &&
        !(e instanceof GraphThrottleError) &&
        (e.status === 410 || /resync|syncstate/i.test(e.code))
      ) {
        // The token expired or Graph asked for a resync (410 Gone): enumerate
        // from scratch. Files already copied with an unchanged cTag are skipped.
        store.delCursor(W, 'delta');
        return;
      }
      throw e;
    }

    // Resolving parents and following moves can hit throttling part-way
    // through the page, which re-runs it — so queued files, stats and errors
    // are only recorded once the whole page is handled.
    const files: FileWork[] = [];
    const errors: ItemErrorInput[] = [];
    const tally = { discovered: 0, skipped: 0, migrated: 0 };
    for (const item of page.items) {
      if (item.deleted) continue;
      if (item.root !== undefined) {
        this.rememberSrcFolder(ctx, item.id, { name: '', parentId: null });
        continue;
      }
      if (item.folder) {
        await this.followFolder(ctx, srcDriveId, dstDriveId, item, errors);
        continue;
      }
      const parentId = item.parentReference?.id;
      const parentPath = parentId ? await this.srcPath(ctx, srcDriveId, parentId) : '';
      const path = parentPath ? `${parentPath}/${item.name ?? ''}` : item.name ?? '';
      if (isPathExcluded(path, ctx.pass.filters.driveExcludePaths)) {
        if (item.file) tally.skipped++;
        continue;
      }
      if (!item.file || !parentId) {
        errors.push({
          itemType: 'driveItem',
          itemId: item.id,
          itemName: path,
          code: 'unsupported_item',
          message: 'drive item is neither file nor folder (e.g. OneNote package); skipped',
        });
        continue;
      }
      tally.discovered++;
      const file: FileWork = {
        srcId: item.id,
        parentId,
        path,
        name: item.name ?? 'unnamed',
        size: item.size ?? 0,
        downloadUrl: item['@microsoft.graph.downloadUrl'],
        cTag: item.cTag,
        fsInfo: item.fileSystemInfo,
      };
      const prev = readCopied(store.mapGet(W, 'item', item.id));
      if (prev && prev.c === (item.cTag ?? '')) {
        if (prev.legacy) {
          // The path-based version put every file at the drive root (delta
          // results carry no path). Root files are already where they belong;
          // nested ones are copied again into their folders below.
          if (!parentPath) {
            store.mapPut(W, 'item', item.id, copied(prev.d, file));
            tally.skipped++;
            continue;
          }
        } else if (prev.p === parentId && prev.n === file.name) {
          tally.skipped++; // unchanged since the previous pass
          continue;
        } else if (await this.moveCopiedFile(ctx, srcDriveId, dstDriveId, prev.d, file)) {
          tally.migrated++; // moved or renamed at the source; content unchanged
          continue;
        }
      }
      files.push(file);
    }

    for (const f of files) store.pushWork(W, 'file', f);
    for (const err of errors) report.itemError(W, err);
    for (const [field, n] of Object.entries(tally) as [keyof typeof tally, number][]) {
      if (n > 0) report.stat(W, field, n);
    }
    store.setState(W, 'advance', {
      cursor: page.deltaLink ?? page.nextLink,
      last: Boolean(page.deltaLink) || !page.nextLink,
    } satisfies DeltaAdvance);
  }

  private rememberSrcFolder(ctx: MigrationContext, id: string, folder: SrcFolder): void {
    ctx.store.mapPut(W, 'srcfolder', id, JSON.stringify(folder));
  }

  /** A source folder's name and parent, looked up if the delta feed hasn't shown it yet. */
  private async srcFolder(ctx: MigrationContext, srcDriveId: string, id: string): Promise<SrcFolder> {
    const known = ctx.store.mapGet(W, 'srcfolder', id);
    if (known) return JSON.parse(known) as SrcFolder;
    const item = await ctx.source.get<DriveItem>(`/drives/${srcDriveId}/items/${id}?$select=id,name,root,parentReference`);
    const folder: SrcFolder =
      item.root !== undefined ? { name: '', parentId: null } : { name: item.name ?? '', parentId: item.parentReference?.id ?? null };
    this.rememberSrcFolder(ctx, id, folder);
    return folder;
  }

  /** Relative path of a source folder ('' for the root). */
  private async srcPath(ctx: MigrationContext, srcDriveId: string, folderId: string): Promise<string> {
    const names: string[] = [];
    let id: string | null = folderId;
    for (let depth = 0; id && depth < 100; depth++) {
      const folder: SrcFolder = await this.srcFolder(ctx, srcDriveId, id);
      if (folder.parentId === null) break;
      names.unshift(folder.name);
      id = folder.parentId;
    }
    return names.join('/');
  }

  /**
   * Record a folder from the delta feed. If it was renamed or moved since it
   * was last seen and already exists in the destination, do the same there —
   * delta reports only the folder, not the items under it.
   */
  private async followFolder(
    ctx: MigrationContext,
    srcDriveId: string,
    dstDriveId: string,
    item: DriveItem,
    errors: ItemErrorInput[]
  ): Promise<void> {
    const { store } = ctx;
    const next: SrcFolder = { name: item.name ?? '', parentId: item.parentReference?.id ?? null };
    const raw = store.mapGet(W, 'srcfolder', item.id);
    const prev = raw ? (JSON.parse(raw) as SrcFolder) : null;
    const destId = store.mapGet(W, 'folder', item.id);
    if (prev && destId && (prev.name !== next.name || prev.parentId !== next.parentId)) {
      try {
        const destParent = next.parentId ? await this.ensureDestFolder(ctx, srcDriveId, dstDriveId, next.parentId) : undefined;
        await ctx.dest.patch(`/drives/${dstDriveId}/items/${destId}`, {
          name: next.name,
          ...(destParent ? { parentReference: { id: destParent } } : {}),
        });
      } catch (e) {
        if (!(e instanceof GraphError) || e instanceof GraphThrottleError) throw e;
        if (e.status === 404) {
          store.mapDel(W, 'folder', item.id); // gone in the destination: recreated when next needed
        } else {
          errors.push({
            itemType: 'folder',
            itemId: item.id,
            itemName: next.name,
            code: e.code,
            message: `folder was renamed or moved at the source but not in the destination: ${e.message}`,
          });
        }
      }
    }
    this.rememberSrcFolder(ctx, item.id, next);
  }

  /** Move/rename an already-copied file to match the source. Returns false if it must be copied again. */
  private async moveCopiedFile(
    ctx: MigrationContext,
    srcDriveId: string,
    dstDriveId: string,
    destId: string,
    file: FileWork
  ): Promise<boolean> {
    try {
      const destParent = await this.ensureDestFolder(ctx, srcDriveId, dstDriveId, file.parentId);
      await ctx.dest.patch(`/drives/${dstDriveId}/items/${destId}`, {
        name: file.name,
        parentReference: { id: destParent },
      });
    } catch (e) {
      if (!(e instanceof GraphError) || e instanceof GraphThrottleError) throw e;
      return false; // the destination copy is gone or can't be moved
    }
    ctx.store.mapPut(W, 'item', file.srcId, copied(destId, file));
    return true;
  }

  /**
   * Find-or-create the destination folder mirroring a source folder (by id).
   * If a mapped ancestor turns out to have been deleted in the destination,
   * it is forgotten and the chain recreated.
   */
  private async ensureDestFolder(
    ctx: MigrationContext,
    srcDriveId: string,
    dstDriveId: string,
    srcFolderId: string,
    depth = 0
  ): Promise<string> {
    const { store, dest } = ctx;
    const mapped = store.mapGet(W, 'folder', srcFolderId);
    if (mapped) return mapped;

    const folder = await this.srcFolder(ctx, srcDriveId, srcFolderId);
    let destId: string;
    if (folder.parentId === null) {
      destId = (await dest.get<DriveItem>(`/drives/${dstDriveId}/root`)).id;
    } else {
      const parentId = await this.ensureDestFolder(ctx, srcDriveId, dstDriveId, folder.parentId, depth + 1);
      try {
        const created = await dest.post<DriveItem>(`/drives/${dstDriveId}/items/${parentId}/children`, {
          name: folder.name,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        });
        destId = created.id;
      } catch (e) {
        if (e instanceof GraphError && e.status === 404 && depth < 100 && store.mapGet(W, 'folder', folder.parentId)) {
          // The mapped parent was deleted in the destination: recreate it too.
          store.mapDel(W, 'folder', folder.parentId);
          return this.ensureDestFolder(ctx, srcDriveId, dstDriveId, srcFolderId, depth + 1);
        }
        if (!(e instanceof GraphError && (e.status === 409 || e.code === 'nameAlreadyExists'))) throw e;
        const existing = await dest.get<DriveItem>(
          `/drives/${dstDriveId}/items/${parentId}:/${encodeURIComponent(folder.name)}`
        );
        destId = existing.id;
      }
    }
    store.mapPut(W, 'folder', srcFolderId, destId);
    return destId;
  }

  private async refreshDownloadUrl(ctx: MigrationContext, srcDriveId: string, srcId: string): Promise<string> {
    const item = await ctx.source.get<DriveItem>(`/drives/${srcDriveId}/items/${srcId}`);
    const url = item['@microsoft.graph.downloadUrl'];
    if (!url) throw new GraphError(404, 'no_download_url', `no download URL for item ${srcId}`);
    return url;
  }

  /**
   * Record a failed file. It is queued for a later pass (up to
   * MAX_FILE_TRIES attempts): once the delta cursor moves past it, the feed
   * would only offer it again if the file changed.
   */
  private queueFileRetry(ctx: MigrationContext, file: FileWork, e: GraphError): void {
    const attempt = (file.tries ?? 0) + 1;
    const final = attempt >= MAX_FILE_TRIES;
    ctx.report.itemError(W, {
      itemType: 'file',
      itemId: file.srcId,
      itemName: file.path,
      code: e.code,
      message: final
        ? `${e.message} (giving up after ${attempt} attempts)`
        : `${e.message} (will retry on the next pass, attempt ${attempt}/${MAX_FILE_TRIES})`,
    });
    ctx.report.stat(W, 'failed');
    if (final) return;
    ctx.store.pushWork(W, 'fileretry', {
      srcId: file.srcId,
      parentId: file.parentId,
      path: file.path,
      name: file.name,
      size: file.size,
      cTag: file.cTag,
      fsInfo: file.fsInfo,
      // download URLs are short-lived; the retry fetches a fresh one
      tries: attempt,
      pass: ctx.store.passSeq,
    } satisfies FileWork);
  }

  private async copyFile(
    ctx: MigrationContext,
    srcDriveId: string,
    dstDriveId: string,
    workId: number,
    file: FileWork,
    recreatedFolder = false
  ): Promise<void> {
    const { store, dest, report } = ctx;
    // Which side a 404 came from decides what it means: the source file was
    // deleted (skip it) or a destination folder was (recreate it).
    let side: 'source' | 'dest' = 'dest';
    try {
      if (!file.parentId) {
        // Queued by the path-based version mid-pass: look up where it lives.
        side = 'source';
        const item = await ctx.source.get<DriveItem>(`/drives/${srcDriveId}/items/${file.srcId}?$select=id,parentReference`);
        file.parentId = item.parentReference?.id ?? '';
        file.path ??= file.name;
        side = 'dest';
      }
      const parentId = await this.ensureDestFolder(ctx, srcDriveId, dstDriveId, file.parentId);
      const encName = encodeURIComponent(file.name);

      if (file.size > LARGE_FILE_THRESHOLD) {
        const session = await dest.post<UploadSession>(
          `/drives/${dstDriveId}/items/${parentId}:/${encName}:/createUploadSession`,
          {
            item: {
              '@microsoft.graph.conflictBehavior': 'replace',
              name: file.name,
              ...(file.fsInfo ? { fileSystemInfo: file.fsInfo } : {}),
            },
          }
        );
        store.setState(W, 'upload', { ...file, sessionUrl: session.uploadUrl, offset: 0 } satisfies UploadState);
        store.popWork(workId);
        return;
      }

      // Small file: single direct upload.
      let bytes: ArrayBuffer = new ArrayBuffer(0);
      if (file.size > 0) {
        side = 'source';
        let url = file.downloadUrl ?? (await this.refreshDownloadUrl(ctx, srcDriveId, file.srcId));
        try {
          bytes = await ctx.source.downloadRange(url, 0, file.size - 1);
        } catch (e) {
          if (e instanceof GraphError && [401, 403, 410].includes(e.status)) {
            url = await this.refreshDownloadUrl(ctx, srcDriveId, file.srcId);
            bytes = await ctx.source.downloadRange(url, 0, file.size - 1);
          } else {
            throw e;
          }
        }
        side = 'dest';
      }
      const created = await dest.put<DriveItem>(
        `/drives/${dstDriveId}/items/${parentId}:/${encName}:/content?@microsoft.graph.conflictBehavior=replace`,
        new Uint8Array(bytes)
      );
      if (file.fsInfo) {
        await dest
          .patch(`/drives/${dstDriveId}/items/${created.id}`, { fileSystemInfo: file.fsInfo })
          .catch(() => undefined); // timestamp fidelity is best-effort
      }
      store.mapPut(W, 'item', file.srcId, copied(created.id, file));
      report.stat(W, 'migrated');
      report.bytes(W, file.size);
      store.popWork(workId);
      ctx.budget.itemDone();
    } catch (e) {
      if (!(e instanceof GraphError) || e instanceof GraphThrottleError) throw e;
      if (side === 'source' && e.status === 404) {
        report.stat(W, 'skipped'); // deleted at source since enumeration
      } else if (side === 'dest' && e.status === 404 && !recreatedFolder && store.mapGet(W, 'folder', file.parentId)) {
        // The destination folder was deleted: forget it so it's recreated, and try once more.
        store.mapDel(W, 'folder', file.parentId);
        return this.copyFile(ctx, srcDriveId, dstDriveId, workId, file, true);
      } else {
        this.queueFileRetry(ctx, file, e);
      }
      store.popWork(workId);
      ctx.budget.itemDone();
    }
  }

  private async continueUpload(ctx: MigrationContext, srcDriveId: string, up: UploadState): Promise<void> {
    const { store, report } = ctx;
    const range = nextChunkRange(up.offset, up.size);
    if (!range) {
      store.delState(W, 'upload');
      return;
    }
    try {
      let url = up.downloadUrl ?? (await this.refreshDownloadUrl(ctx, srcDriveId, up.srcId));
      let bytes: ArrayBuffer;
      try {
        bytes = await ctx.source.downloadRange(url, range.start, range.end);
      } catch (e) {
        if (e instanceof GraphError && [401, 403, 410].includes(e.status)) {
          url = await this.refreshDownloadUrl(ctx, srcDriveId, up.srcId);
          up.downloadUrl = url;
          bytes = await ctx.source.downloadRange(url, range.start, range.end);
        } else {
          throw e;
        }
      }
      const result = await putUploadChunk(up.sessionUrl, bytes, range.start, range.end, up.size);
      up.offset = result.nextOffset ?? range.end + 1;
      up.downloadUrl = url;
      if (result.nextOffset === undefined) report.bytes(W, range.length);
      ctx.budget.itemDone();
      if (result.done) {
        const destId = (result.item?.id as string) ?? 'uploaded';
        store.mapPut(W, 'item', up.srcId, copied(destId, up));
        report.stat(W, 'migrated');
        store.delState(W, 'upload');
      } else {
        store.setState(W, 'upload', up);
      }
    } catch (e) {
      if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        this.queueFileRetry(ctx, up, e);
        store.delState(W, 'upload');
        ctx.budget.itemDone();
        return;
      }
      throw e;
    }
  }
}
