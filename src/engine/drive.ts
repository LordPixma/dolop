// OneDrive migration engine.
//
// Enumerates the source drive with the Graph delta feed (the persisted delta
// token makes later passes incremental), lazily mirrors the folder hierarchy,
// and copies files: ≤4 MB via direct upload, larger via resumable upload
// sessions streamed in 10 MiB chunks (range-read from the source download URL,
// chunk-PUT to the destination session — the file never has to fit in Worker
// memory). cTag comparison re-copies files whose content changed since the
// previous pass.

import { GraphError } from '../graph/client';
import type { DriveItem, GraphDrive, UploadSession } from '../graph/types';
import { isPathExcluded, LARGE_FILE_THRESHOLD, nextChunkRange } from '../util';
import { putUploadChunk } from './upload';
import type { MigrationContext, StepResult, WorkloadEngine } from './workload';

const W = 'drive';

interface FileWork {
  srcId: string;
  parentPath: string; // relative folder path, '' = root
  name: string;
  size: number;
  downloadUrl?: string;
  cTag?: string;
  fsInfo?: { createdDateTime?: string; lastModifiedDateTime?: string };
}

interface UploadState extends FileWork {
  sessionUrl: string;
  offset: number;
}

function relPathFromParentReference(path: string | undefined): string {
  if (!path) return '';
  const idx = path.indexOf('root:');
  if (idx < 0) return '';
  return path.slice(idx + 5).replace(/^\//, '');
}

function encodePath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

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
      // 2. Copy the next queued file.
      const work = store.peekWork<FileWork>(W, 'file');
      if (work) {
        await this.copyFile(ctx, srcDriveId, dstDriveId, work.id, work.payload);
        continue;
      }
      // 3. Advance delta enumeration.
      if (store.getState<boolean>(W, 'enumDone')) return 'done';
      await this.fetchDeltaPage(ctx, srcDriveId);
    }
    return 'continue';
  }

  private async fetchDeltaPage(ctx: MigrationContext, srcDriveId: string): Promise<void> {
    const { store, source, report } = ctx;
    const url = store.getCursor(W, 'delta') ?? `/drives/${srcDriveId}/root/delta`;
    const page = await source.page<DriveItem>(url, 100);

    for (const item of page.items) {
      if (item.root !== undefined || item.deleted) continue;
      const parentPath = relPathFromParentReference(item.parentReference?.path);
      const fullPath = parentPath ? `${parentPath}/${item.name ?? ''}` : item.name ?? '';
      if (isPathExcluded(fullPath, ctx.pass.filters.driveExcludePaths)) {
        if (item.file) report.stat(W, 'skipped');
        continue;
      }
      if (item.folder) continue; // folders are created lazily when files land in them
      if (!item.file) {
        report.itemError(W, {
          itemType: 'driveItem',
          itemId: item.id,
          itemName: fullPath,
          code: 'unsupported_item',
          message: 'drive item is neither file nor folder (e.g. OneNote package); skipped',
        });
        continue;
      }
      report.stat(W, 'discovered');
      const mapped = store.mapGet(W, 'item', item.id);
      if (mapped) {
        const [, prevCTag] = mapped.split('|');
        if (prevCTag && prevCTag === (item.cTag ?? '')) {
          report.stat(W, 'skipped');
          continue; // unchanged since previous pass
        }
      }
      store.pushWork(W, 'file', {
        srcId: item.id,
        parentPath,
        name: item.name ?? 'unnamed',
        size: item.size ?? 0,
        downloadUrl: item['@microsoft.graph.downloadUrl'],
        cTag: item.cTag,
        fsInfo: item.fileSystemInfo,
      } satisfies FileWork);
    }

    if (page.deltaLink) {
      store.setCursor(W, 'delta', page.deltaLink);
      store.setState(W, 'enumDone', true);
    } else if (page.nextLink) {
      store.setCursor(W, 'delta', page.nextLink);
    } else {
      store.setState(W, 'enumDone', true);
    }
  }

  /** Find-or-create the destination folder for a relative path; '' = root. */
  private async ensureFolder(ctx: MigrationContext, dstDriveId: string, relPath: string): Promise<string> {
    const { store, dest } = ctx;
    const key = relPath.toLowerCase();
    const cached = store.mapGet(W, 'path', key || '/');
    if (cached) return cached;

    if (!relPath) {
      const root = await dest.get<DriveItem>(`/drives/${dstDriveId}/root`);
      store.mapPut(W, 'path', '/', root.id);
      return root.id;
    }
    const segments = relPath.split('/').filter(Boolean);
    const name = segments[segments.length - 1]!;
    const parentPath = segments.slice(0, -1).join('/');
    const parentId = await this.ensureFolder(ctx, dstDriveId, parentPath);
    let id: string;
    try {
      const created = await dest.post<DriveItem>(`/drives/${dstDriveId}/items/${parentId}/children`, {
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      });
      id = created.id;
    } catch (e) {
      if (e instanceof GraphError && (e.status === 409 || e.code === 'nameAlreadyExists')) {
        const existing = await dest.get<DriveItem>(
          `/drives/${dstDriveId}/items/${parentId}:/${encodeURIComponent(name)}`
        );
        id = existing.id;
      } else {
        throw e;
      }
    }
    store.mapPut(W, 'path', key, id);
    return id;
  }

  private async refreshDownloadUrl(ctx: MigrationContext, srcDriveId: string, srcId: string): Promise<string> {
    const item = await ctx.source.get<DriveItem>(`/drives/${srcDriveId}/items/${srcId}`);
    const url = item['@microsoft.graph.downloadUrl'];
    if (!url) throw new GraphError(404, 'no_download_url', `no download URL for item ${srcId}`);
    return url;
  }

  private async copyFile(
    ctx: MigrationContext,
    srcDriveId: string,
    dstDriveId: string,
    workId: number,
    file: FileWork
  ): Promise<void> {
    const { store, dest, report } = ctx;
    try {
      const parentId = await this.ensureFolder(ctx, dstDriveId, file.parentPath);
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
      store.mapPut(W, 'item', file.srcId, `${created.id}|${file.cTag ?? ''}`);
      report.stat(W, 'migrated');
      report.bytes(W, file.size);
      store.popWork(workId);
      ctx.budget.itemDone();
    } catch (e) {
      if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        if (e.status === 404) {
          report.stat(W, 'skipped'); // deleted at source since enumeration
        } else {
          report.itemError(W, {
            itemType: 'file',
            itemId: file.srcId,
            itemName: `${file.parentPath}/${file.name}`,
            code: e.code,
            message: e.message,
          });
          report.stat(W, 'failed');
        }
        store.popWork(workId);
        ctx.budget.itemDone();
        return;
      }
      throw e;
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
      up.offset = range.end + 1;
      up.downloadUrl = url;
      report.bytes(W, range.length);
      ctx.budget.itemDone();
      if (result.done) {
        const destId = (result.item?.id as string) ?? 'uploaded';
        store.mapPut(W, 'item', up.srcId, `${destId}|${up.cTag ?? ''}`);
        report.stat(W, 'migrated');
        store.delState(W, 'upload');
      } else {
        store.setState(W, 'upload', up);
      }
    } catch (e) {
      if (e instanceof GraphError && e.name !== 'GraphThrottleError') {
        report.itemError(W, {
          itemType: 'file',
          itemId: up.srcId,
          itemName: `${up.parentPath}/${up.name}`,
          code: e.code,
          message: e.message,
        });
        report.stat(W, 'failed');
        store.delState(W, 'upload');
        ctx.budget.itemDone();
        return;
      }
      throw e;
    }
  }
}
