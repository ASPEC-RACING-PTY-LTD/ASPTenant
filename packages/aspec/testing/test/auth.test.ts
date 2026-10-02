import {
  createHmac,
  verify as cryptoVerify,
  generateKeyPairSync,
  timingSafeEqual,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMockPermissionChecker,
  createTestJwtSigner,
  expectAllowed,
  expectDenied,
  signCookieValue,
  signTestJwt,
  unsignCookieValue,
  verifyTestJwt,
} from '../src/index.js';

describe('auth helpers', () => {
  it('signs and verifies HS256 JWTs independently with node:crypto', () => {
    const secret = Buffer.alloc(32, 9);
    const token = signTestJwt({ sub: 'u1', roles: ['admin'] }, { secret, expiresIn: 3600 });
    const verified = verifyTestJwt(token, { secret });
    expect(verified.payload.sub).toBe('u1');

    const [h, p, s] = token.split('.') as [string, string, string];
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const actual = Buffer.from(s, 'base64url');
    expect(timingSafeEqual(expected, actual)).toBe(true);
  });

  it('signs and verifies ES256 JWTs independently with node:crypto', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const token = signTestJwt({ sub: 'u2' }, { algorithm: 'ES256', privateKey });
    const verified = verifyTestJwt(token, { publicKey });
    expect(verified.payload.sub).toBe('u2');

    const [h, p, s] = token.split('.') as [string, string, string];
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('creates a reusable signer and session cookie signatures', () => {
    const signer = createTestJwtSigner({ algorithm: 'HS256', issuer: 'test' });
    const token = signer.signFor({ id: 'u3', roles: ['member'] });
    expect(signer.verify(token).payload.sub).toBe('u3');
    const signed = signCookieValue('sid', 'cookie-secret', 'express');
    expect(unsignCookieValue(signed, 'cookie-secret', 'express')).toBe('sid');
  });
});

describe('authz helpers', () => {
  it('records checks and supports wildcards and resource matching', async () => {
    const checker = createMockPermissionChecker({
      allow: [
        {
          permission: 'docs:*',
          subject: { roles: ['editor'] },
          resource: { type: 'doc', ownerId: '$subject' },
        },
      ],
      deny: [{ permission: 'docs:delete', subject: { id: 'blocked' } }],
    });
    const editor = { id: 'e1', roles: ['editor'] };
    await expectAllowed(checker, editor, 'docs:read', { type: 'doc', ownerId: 'e1' });
    await expectDenied(checker, editor, 'docs:read', { type: 'doc', ownerId: 'other' });
    await expectDenied(checker, { id: 'blocked' }, 'docs:delete');
    checker.expectChecked('docs:read', { subjectId: 'e1', allowed: true });
    expect(checker.checks.length).toBeGreaterThan(0);
  });
});
