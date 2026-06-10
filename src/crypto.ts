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
