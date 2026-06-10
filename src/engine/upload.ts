// Resumable upload-session helper. Upload session URLs are pre-authenticated;
// per Graph docs no Authorization header may be attached, so this bypasses
// GraphClient deliberately.

import { GraphError, GraphThrottleError } from '../graph/client';

export interface ChunkResult {
  done: boolean;
  /** driveItem (or attachment) returned by the final chunk, when present. */
  item?: Record<string, unknown>;
}

export async function putUploadChunk(
  sessionUrl: string,
  bytes: ArrayBuffer,
  start: number,
  end: number,
  total: number
): Promise<ChunkResult> {
  const res = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
    body: bytes,
  });
  if (res.status === 200 || res.status === 201) {
    const item = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    return { done: true, item };
  }
  if (res.status === 202) {
    await res.body?.cancel();
    return { done: false };
  }
  if (res.status === 429 || res.status === 503 || res.status === 504) {
    const h = res.headers.get('retry-after');
    await res.body?.cancel();
    const secs = h ? parseInt(h, 10) : NaN;
    throw new GraphThrottleError(res.status, (Number.isFinite(secs) ? Math.min(secs, 300) : 15) * 1000);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  throw new GraphError(
    res.status,
    body.error?.code ?? `upload_http_${res.status}`,
    body.error?.message ?? `upload chunk failed (HTTP ${res.status})`
  );
}
