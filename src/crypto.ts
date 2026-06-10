// AES-256-GCM encryption for tenant client secrets stored in D1.
// The master key lives only in the ENCRYPTION_KEY Worker secret.

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(masterKeyB64);
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)');
  }
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Returns "v1:<iv b64>:<ciphertext b64>". */
export async function encryptSecret(plaintext: string, masterKeyB64: string): Promise<string> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `v1:${b64encode(iv)}:${b64encode(new Uint8Array(ct))}`;
}

export async function decryptSecret(stored: string, masterKeyB64: string): Promise<string> {
  const [version, ivB64, ctB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('unrecognized secret format');
  const key = await importKey(masterKeyB64);
  const iv = b64decode(ivB64);
  const ct = b64decode(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ct.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// HMAC-signed state tokens (admin consent flow round-trips through Microsoft,
// so the callback must be able to authenticate its own state parameter).

function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(masterKeyB64);
  return crypto.subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** Returns "<payload b64url>.<sig b64url>" valid for ttlMs. */
export async function signState(
  payload: Record<string, string>,
  masterKeyB64: string,
  ttlMs = 60 * 60 * 1000
): Promise<string> {
  const body = b64url(
    new TextEncoder().encode(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }))
  );
  const key = await hmacKey(masterKeyB64);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** Verifies signature + expiry; returns the payload or null. */
export async function verifyState(
  state: string,
  masterKeyB64: string
): Promise<Record<string, string> | null> {
  const [body, sigB64url] = state.split('.');
  if (!body || !sigB64url) return null;
  const key = await hmacKey(masterKeyB64);
  const pad = '='.repeat((4 - (sigB64url.length % 4)) % 4);
  const sig = b64decode(sigB64url.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig.buffer as ArrayBuffer,
    new TextEncoder().encode(body)
  );
  if (!ok) return null;
  try {
    const bodyPad = '='.repeat((4 - (body.length % 4)) % 4);
    const decoded = JSON.parse(
      new TextDecoder().decode(b64decode(body.replace(/-/g, '+').replace(/_/g, '/') + bodyPad))
    ) as Record<string, string> & { exp?: number };
    if (typeof decoded.exp !== 'number' || decoded.exp < Date.now()) return null;
    const { exp: _exp, ...payload } = decoded;
    return payload as Record<string, string>;
  } catch {
    return null;
  }
}
