// Microsoft Graph client: app-only (client credentials) auth with KV token cache,
// throttling awareness (429/503 → GraphThrottleError with retry-after), and
// helpers for paged collections and raw content streams.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestPath?: string
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** Thrown on 429/503/504 — caller should pause the whole tick for retryAfterMs. */
export class GraphThrottleError extends GraphError {
  constructor(status: number, public retryAfterMs: number, path?: string) {
    super(status, 'throttled', `Graph throttled (HTTP ${status}), retry after ${retryAfterMs}ms`, path);
    this.name = 'GraphThrottleError';
  }
}

/** Thrown when token acquisition fails — fatal for the pass (bad credentials/consent). */
export class GraphAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphAuthError';
  }
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

/** Default per-request timeout; byte-range transfers get TRANSFER_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = 60_000;
export const TRANSFER_TIMEOUT_MS = 120_000;

/** fetch with a deadline; a timeout surfaces as a clear Error (a failed tick, retried with backoff). */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s: ${init.method ?? 'GET'} ${url.split('?')[0]}`);
    }
    throw e;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * KV key for a cached token. It includes a hash of the client secret, so a
 * rotated or mistyped secret is checked against Entra instead of being served
 * a token minted with the old one (which would let Verify pass for an hour).
 */
async function tokenCacheKey(creds: GraphCredentials): Promise<string> {
  return `gtok:${creds.tenantId}:${creds.clientId}:${(await sha256Hex(creds.clientSecret)).slice(0, 16)}`;
}

/**
 * Acquire an app-only access token, cached in KV until shortly before expiry.
 */
async function fetchToken(creds: GraphCredentials, kv: KVNamespace, timeoutMs: number): Promise<TokenCacheEntry> {
  const cacheKey = await tokenCacheKey(creds);
  const cached = await kv.get<TokenCacheEntry>(cacheKey, 'json');
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

  const res = await fetchWithTimeout(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
    timeoutMs
  );
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new GraphAuthError(
      `token acquisition failed for tenant ${creds.tenantId}: ${body.error ?? res.status} ${
        (body.error_description ?? '').split('\n')[0] ?? ''
      }`.trim()
    );
  }
  const entry: TokenCacheEntry = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  const ttl = Math.max(60, (body.expires_in ?? 3600) - 300);
  await kv.put(cacheKey, JSON.stringify(entry), { expirationTtl: ttl });
  return entry;
}

function parseRetryAfter(res: Response): number {
  const h = res.headers.get('retry-after');
  const secs = h ? parseInt(h, 10) : NaN;
  return Number.isFinite(secs) ? Math.min(secs, 300) * 1000 : 15_000;
}

export interface GraphRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Return the raw Response instead of parsing JSON. */
  raw?: boolean;
}

export interface PagedResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export class GraphClient {
  /** Number of Graph HTTP calls issued (budget accounting). */
  requestCount = 0;
  /** This client's token, so only the first request of a tick reads KV. */
  private token: TokenCacheEntry | null = null;
  private readonly timeoutMs: number;

  constructor(
    private creds: GraphCredentials,
    private kv: KVNamespace,
    opts: { timeoutMs?: number } = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async accessToken(): Promise<string> {
    if (!this.token || this.token.expiresAt <= Date.now() + 60_000) {
      this.token = await fetchToken(this.creds, this.kv, this.timeoutMs);
    }
    return this.token.token;
  }

  private async dropToken(): Promise<void> {
    this.token = null;
    await this.kv.delete(await tokenCacheKey(this.creds));
  }

  get tenantId(): string {
    return this.creds.tenantId;
  }

  /**
   * Issue a Graph request. `path` may be relative ("/users/...") or an absolute
   * URL (nextLink/deltaLink/upload-session URLs).
   */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: GraphRequestOptions = {}
  ): Promise<T> {
    const res = await this.requestRaw(method, path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async requestRaw(method: string, path: string, opts: GraphRequestOptions = {}): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`;
    let attempt = 0;
    for (;;) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        ...(opts.headers ?? {}),
      };
      let body: BodyInit | undefined;
      if (opts.body !== undefined) {
        if (
          opts.body instanceof ArrayBuffer ||
          opts.body instanceof Uint8Array ||
          opts.body instanceof ReadableStream
        ) {
          body = opts.body as BodyInit;
        } else {
          headers['content-type'] = headers['content-type'] ?? 'application/json';
          body = JSON.stringify(opts.body);
        }
      }
      this.requestCount++;
      const res = await fetchWithTimeout(url, { method, headers, body }, this.timeoutMs);

      if (res.ok) return res;

      if (res.status === 429 || res.status === 503 || res.status === 504) {
        await res.body?.cancel();
        throw new GraphThrottleError(res.status, parseRetryAfter(res), path);
      }
      // One retry for a token that expired mid-flight, and for transient 5xx
      // on idempotent requests. A POST is never re-sent: the 5xx may have come
      // after the item was created, and a second POST would duplicate it.
      if ((res.status === 401 || (res.status >= 500 && method !== 'POST')) && attempt === 0) {
        attempt++;
        if (res.status === 401) await this.dropToken();
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const errBody = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      throw new GraphError(
        res.status,
        errBody.error?.code ?? `http_${res.status}`,
        errBody.error?.message ?? `Graph request failed with HTTP ${res.status}`,
        path
      );
    }
  }

  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, { headers });
  }

  post<T = unknown>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('POST', path, { body, headers });
  }

  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  put<T = unknown>(path: string, body: ArrayBuffer | Uint8Array, headers?: Record<string, string>): Promise<T> {
    return this.request<T>('PUT', path, { body, headers });
  }

  delete(path: string): Promise<void> {
    return this.request<void>('DELETE', path);
  }

  /** Fetch one page of a collection; returns items plus next/delta links. */
  async page<T>(
    pathOrUrl: string,
    pageSize = 50
  ): Promise<{ items: T[]; nextLink?: string; deltaLink?: string }> {
    const res = await this.request<PagedResponse<T>>('GET', pathOrUrl, {
      headers: { prefer: `odata.maxpagesize=${pageSize}` },
    });
    return {
      items: res.value ?? [],
      nextLink: res['@odata.nextLink'],
      deltaLink: res['@odata.deltaLink'],
    };
  }

  /** Eagerly fetch every page of a small collection (folders, calendars, lists…). */
  async listAll<T>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path;
    for (let i = 0; url && i < maxPages; i++) {
      const page: { items: T[]; nextLink?: string } = await this.page<T>(url, 100);
      out.push(...page.items);
      url = page.nextLink;
    }
    return out;
  }

  /**
   * Download a byte range from a pre-authenticated URL (e.g. OneDrive
   * @microsoft.graph.downloadUrl). No bearer token is attached.
   */
  async downloadRange(downloadUrl: string, start: number, end: number): Promise<ArrayBuffer> {
    this.requestCount++;
    const res = await fetchWithTimeout(
      downloadUrl,
      { headers: { range: `bytes=${start}-${end}` } },
      Math.max(this.timeoutMs, TRANSFER_TIMEOUT_MS)
    );
    if (res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      throw new GraphThrottleError(res.status, parseRetryAfter(res));
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new GraphError(res.status, 'download_failed', `range download failed (HTTP ${res.status})`);
    }
    return await res.arrayBuffer();
  }
}
