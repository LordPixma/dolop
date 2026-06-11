// Pure utility helpers (no Workers runtime dependencies — unit-testable in Node).

export function newId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `${prefix}_${s}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Map a source UPN to a destination UPN by swapping the domain suffix. */
export function mapUpnToDomain(sourceUpn: string, targetDomain: string): string {
  const at = sourceUpn.lastIndexOf('@');
  const local = at >= 0 ? sourceUpn.slice(0, at) : sourceUpn;
  return `${local}@${targetDomain.replace(/^@/, '')}`;
}

export interface CsvMappingRow {
  sourceUpn: string;
  destUpn: string;
}

/**
 * Parse a user-mapping CSV. Accepts an optional header row containing
 * "source"/"destination" (any casing); each data row is `sourceUpn,destUpn`.
 */
export function parseMappingCsv(text: string): { rows: CsvMappingRow[]; errors: string[] } {
  const rows: CsvMappingRow[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim().replace(/^"|"$/g, ''));
    const [a, b] = [parts[0] ?? '', parts[1] ?? ''];
    if (i === 0 && /source/i.test(a) && /dest/i.test(b)) continue; // header
    if (!a.includes('@') || !b.includes('@')) {
      errors.push(`line ${i + 1}: expected "sourceUpn,destUpn", got "${line}"`);
      continue;
    }
    rows.push({ sourceUpn: a.toLowerCase(), destUpn: b.toLowerCase() });
  }
  return { rows, errors };
}

/** Escape a value for inclusion in a CSV cell. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const out = [headers.map(csvCell).join(',')];
  for (const r of rows) out.push(r.map(csvCell).join(','));
  return out.join('\r\n') + '\r\n';
}

/**
 * Compute the next chunk byte range for a resumable upload.
 * Chunk sizes must be multiples of 320 KiB per Microsoft Graph requirements;
 * 10 MiB (32 × 320 KiB) balances throughput against Worker memory.
 */
export const UPLOAD_CHUNK_SIZE = 32 * 320 * 1024; // 10,485,760 bytes

/**
 * Outlook attachment upload sessions reject chunks over 4 MB (unlike OneDrive).
 * 12 × 320 KiB stays 320 KiB-aligned and safely under the limit.
 */
export const MAIL_ATTACHMENT_CHUNK_SIZE = 12 * 320 * 1024; // 3,932,160 bytes

export function nextChunkRange(offset: number, total: number, chunkSize = UPLOAD_CHUNK_SIZE): { start: number; end: number; length: number } | null {
  if (offset >= total) return null;
  const start = offset;
  const end = Math.min(offset + chunkSize, total) - 1;
  return { start, end, length: end - start + 1 };
}

/** Threshold above which Graph requires an upload session instead of a direct upload. */
export const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024 - 1;
export const LARGE_ATTACHMENT_THRESHOLD = 3 * 1024 * 1024 - 1;

/** Exponential backoff with jitter, capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 10));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/** Build a stable signature for pass filters so delta cursors are keyed per-filter-shape. */
export function filterSignature(filters: { mailReceivedBefore?: string; mailReceivedAfter?: string }): string {
  const before = filters.mailReceivedBefore ?? '';
  const after = filters.mailReceivedAfter ?? '';
  return before || after ? `f:${after}..${before}` : 'all';
}

/** Case-insensitive check of a folder path against exclusion rules. */
export function isPathExcluded(path: string, excludes: string[] | undefined): boolean {
  if (!excludes || excludes.length === 0) return false;
  const p = path.toLowerCase().replace(/^\/+|\/+$/g, '');
  return excludes.some((e) => {
    const x = e.toLowerCase().replace(/^\/+|\/+$/g, '');
    return p === x || p.startsWith(x + '/');
  });
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Constant-time string comparison for token checks. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
