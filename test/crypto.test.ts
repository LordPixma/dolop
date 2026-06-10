import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto';

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe('secret encryption', () => {
  it('round-trips a client secret', async () => {
    const key = randomKey();
    const stored = await encryptSecret('super~secret/value+with=padding', key);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('super~secret');
    expect(await decryptSecret(stored, key)).toBe('super~secret/value+with=padding');
  });

  it('produces unique ciphertexts per call (random IV)', async () => {
    const key = randomKey();
    const a = await encryptSecret('same', key);
    const b = await encryptSecret('same', key);
    expect(a).not.toBe(b);
  });

  it('fails with the wrong key', async () => {
    const stored = await encryptSecret('value', randomKey());
    await expect(decryptSecret(stored, randomKey())).rejects.toThrow();
  });

  it('rejects malformed keys and payloads', async () => {
    await expect(encryptSecret('x', btoa('short'))).rejects.toThrow(/32 bytes/);
    await expect(decryptSecret('garbage', randomKey())).rejects.toThrow(/unrecognized/);
  });
});
