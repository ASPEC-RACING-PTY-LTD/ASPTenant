import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/errors.js';
import { createHibpChecker } from '../src/hibp.js';
import { createPasswordPolicy, createScryptHasher } from '../src/password.js';
import { STRONG_PASSWORD, testHasher } from './helpers/setup.js';

describe('scrypt hasher', () => {
  it('hashes, verifies and detects rehash needs', async () => {
    const hash = await testHasher.hash(STRONG_PASSWORD);
    expect(hash.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
    expect(await testHasher.verify(hash, STRONG_PASSWORD)).toBe(true);
    expect(await testHasher.verify(hash, 'wrong-password-xx')).toBe(false);
    expect(testHasher.needsRehash(hash)).toBe(false);
    const stronger = createScryptHasher({ logN: 12 });
    expect(stronger.needsRehash(hash)).toBe(true);
  });

  it('rejects malformed hashes without throwing', async () => {
    expect(await testHasher.verify('not-a-hash', STRONG_PASSWORD)).toBe(false);
    expect(await testHasher.verify('$scrypt$ln=99,r=8,p=1$YWJj$YWJj', STRONG_PASSWORD)).toBe(false);
  });
});

describe('password policy', () => {
  it('enforces length bounds', async () => {
    const policy = createPasswordPolicy({ minLength: 12, maxLength: 128 });
    await expect(policy.check('short')).rejects.toMatchObject({ code: 'AUTH_PASSWORD_POLICY' });
    await expect(policy.check(STRONG_PASSWORD)).resolves.toBe(STRONG_PASSWORD);
  });

  it('runs the compromised hook', async () => {
    const policy = createPasswordPolicy({
      isPasswordCompromised: async (p) => p === 'Password12345!',
    });
    await expect(policy.check('Password12345!')).rejects.toBeInstanceOf(AuthError);
    await expect(policy.check(STRONG_PASSWORD)).resolves.toBe(STRONG_PASSWORD);
  });
});

describe('hibp checker', () => {
  it('uses k-anonymity against a local mock', async () => {
    const target = 'PwnedPassword!!';
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha1').update(target, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const checker = createHibpChecker({
      rangeUrl: 'http://hibp.test/range',
      fetch: async (url) => {
        expect(String(url)).toBe(`http://hibp.test/range/${prefix}`);
        return new Response(`${suffix}:12\nAAAAA:1\n`);
      },
    });
    expect(await checker(target)).toBe(true);
    expect(await checker(STRONG_PASSWORD)).toBe(false);
  });
});
