import { describe, expect, it } from 'vitest';
import {
  API_KEY_SCAN_REGEX,
  generateKey,
  hashesEqual,
  hashKey,
  parseKey,
  parsePepper,
  rebuildKeyWithPublicId,
} from '../src/key-format.js';
import { hasAllScopes, scopeCovers, scopesEscalate } from '../src/scopes.js';

describe('key format', () => {
  it('generates parseable keys with valid checksum', () => {
    const parts = generateKey({ prefix: 'ak_live_' });
    expect(parts.key.startsWith('ak_live_')).toBe(true);
    const parsed = parseKey(parts.key, 'ak_live_');
    expect(parsed).toBeDefined();
    expect(parsed!.publicId).toBe(parts.publicId);
    expect(parsed!.checksum).toBe(parts.checksum);
  });

  it('rejects tampered checksums', () => {
    const parts = generateKey();
    const bad = `${parts.key.slice(0, -1)}${parts.key.endsWith('0') ? '1' : '0'}`;
    expect(parseKey(bad, 'ak_live_')).toBeUndefined();
  });

  it('matches the secret scanning regex', () => {
    const parts = generateKey();
    expect(parts.key).toMatch(API_KEY_SCAN_REGEX);
  });

  it('hashes with HMAC and compares in constant time', () => {
    const pepper = Buffer.alloc(32, 7);
    const parts = generateKey();
    const a = hashKey(pepper, parts.key);
    const b = hashKey(pepper, parts.key);
    expect(hashesEqual(a, b)).toBe(true);
    expect(hashesEqual(a, hashKey(pepper, 'other'))).toBe(false);
  });

  it('rebuilds with stable public id', () => {
    const first = generateKey();
    const rebuilt = rebuildKeyWithPublicId(first.prefix, first.publicId);
    const parsed = parseKey(rebuilt.key, first.prefix);
    expect(parsed!.publicId).toBe(first.publicId);
    expect(rebuilt.key).not.toBe(first.key);
  });

  it('requires pepper in production', () => {
    expect(() => parsePepper(undefined, 'production')).toThrow(/pepper/i);
    expect(parsePepper(undefined, 'development').length).toBeGreaterThanOrEqual(32);
  });
});

describe('scopes', () => {
  it('covers wildcards', () => {
    expect(scopeCovers('read:*', 'read:users')).toBe(true);
    expect(scopeCovers('read:users', 'read:*')).toBe(false);
    expect(scopeCovers('*', 'write:x')).toBe(true);
    expect(hasAllScopes(['read:*', 'write:keys'], ['read:users'])).toBe(true);
  });

  it('detects escalation', () => {
    expect(scopesEscalate(['read:users'], ['read:users', 'write:users'])).toBe(true);
    expect(scopesEscalate(['read:*'], ['read:users'])).toBe(false);
  });
});
