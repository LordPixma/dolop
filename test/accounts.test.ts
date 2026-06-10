import { describe, expect, it } from 'vitest';
import { hashPassword, validPassword, validUsername, verifyPassword } from '../src/accounts';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple', 10_000);
    expect(stored.startsWith('v1:10000:')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects wrong passwords and unique salts per hash', async () => {
    const a = await hashPassword('hunter2hunter2', 10_000);
    const b = await hashPassword('hunter2hunter2', 10_000);
    expect(a).not.toBe(b); // random salt
    expect(await verifyPassword('hunter2hunter3', a)).toBe(false);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'v1:not-a-number:AAAA:BBBB')).toBe(false);
    expect(await verifyPassword('x', 'v1:1:AAAA:BBBB')).toBe(false); // below iteration floor
  });
});

describe('credential validation', () => {
  it('validates usernames', () => {
    expect(validUsername('sam')).toBe(true);
    expect(validUsername('sam.odekunle@corp')).toBe(true);
    expect(validUsername('ab')).toBe(false);
    expect(validUsername('-leading')).toBe(false);
    expect(validUsername('has space')).toBe(false);
  });

  it('enforces password length bounds', () => {
    expect(validPassword('short')).toMatch(/at least 10/);
    expect(validPassword('long-enough-password')).toBeNull();
    expect(validPassword('x'.repeat(300))).toMatch(/too long/);
  });
});
