// Resumable upload-session helper. Upload session URLs are pre-authenticated;
// per Graph docs no Authorization header may be attached, so this bypasses
// GraphClient deliberately.

import { fetchWithTimeout, GraphError, GraphThrottleError, TRANSFER_TIMEOUT_MS } from '../graph/client';

export interface ChunkResult {
  done: boolean;
  /** driveItem (or attachment) returned by the final chunk, when present. */
  item?: Record<string, unknown>;
  /** Where the session wants the next range to start, when it isn't right after this one. */
  nextOffset?: number;
}

export async function putUploadChunk(
  sessionUrl: string,
  bytes: ArrayBuffer,
  start: number,
  end: number,
  total: number
): Promise<ChunkResult> {
  const res = await fetchWithTimeout(
    sessionUrl,
    { method: 'PUT', headers: { 'content-range': `bytes ${start}-${end}/${total}` }, body: bytes },
    TRANSFER_TIMEOUT_MS
  );
  if (res.status === 200 || res.status === 201) {
    const item = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // Outlook attachment sessions acknowledge every intermediate chunk with
    // 200 + nextExpectedRanges and the final one with 201. OneDrive uses 202
    // for intermediate chunks and 200/201 (with the driveItem) for the last.
    if (res.status === 200 && Array.isArray(item?.nextExpectedRanges)) return { done: false };
    return { done: true, item };
  }
  if (res.status === 202) {
    await res.body?.cancel();
    return { done: false };
  }
  if (res.status === 416) {
    // The session already holds this range — e.g. the response to an earlier
    // attempt was lost. Ask the session where to continue.
    await res.body?.cancel();
    const next = await nextExpectedOffset(sessionUrl);
    if (next !== null) return { done: false, nextOffset: next };
    throw new GraphError(416, 'upload_range_conflict', 'upload session rejected the byte range and reported no next range');
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

/** Start of the first range an upload session still expects (GET on the session URL). */
async function nextExpectedOffset(sessionUrl: string): Promise<number | null> {
  const res = await fetchWithTimeout(sessionUrl, { method: 'GET' }, TRANSFER_TIMEOUT_MS);
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as { nextExpectedRanges?: string[] };
  const start = parseInt(body.nextExpectedRanges?.[0] ?? '', 10);
  return Number.isFinite(start) ? start : null;
}

/**
 * The `length` bytes at `start` from a response to a ranged GET. A 206 body
 * is the range itself. When the server ignored the Range header (200), the
 * body is streamed and only the requested slice is kept — the whole content
 * (up to 150 MB for an attachment) is never held in memory. Returns fewer
 * bytes if the content ends early; callers check the length.
 */
export async function readByteRange(res: Response, start: number, length: number): Promise<ArrayBuffer> {
  if (res.status === 206 || !res.body) return res.arrayBuffer();
  const out = new Uint8Array(length);
  let filled = 0;
  let position = 0;
  const reader = res.body.getReader();
  try {
    while (filled < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkStart = position;
      position += value.byteLength;
      if (position <= start) continue;
      const from = Math.max(0, start - chunkStart);
      const take = Math.min(value.byteLength - from, length - filled);
      out.set(value.subarray(from, from + take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.buffer.slice(0, filled);
}
