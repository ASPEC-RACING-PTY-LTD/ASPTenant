import { describe, expect, it } from 'vitest';
import { createAuditLogger } from '../src/logger.js';
import { createRedactor, REDACTED } from '../src/redact.js';
import { createMemoryAuditStore } from '../src/stores/memory.js';

describe('createRedactor', () => {
  it('redacts sensitive keys nested and cyclic structures', () => {
    const r = createRedactor();
    const cyclic: Record<string, unknown> = { name: 'ok', password: 'secret' };
    cyclic.self = cyclic;
    const out = r.redact(cyclic) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.name).toBe('ok');
    expect(out.self).toBe('[Circular]');
  });

  it('redacts JWT, bearer, PEM, AWS keys and Luhn card numbers in strings', () => {
    const r = createRedactor();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturepart';
    expect(r.redactString(`token=${jwt}`)).toContain(REDACTED);
    expect(r.redactString('Authorization: Bearer abcdefghijklmnop')).toContain(REDACTED);
    expect(r.redactString('-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----')).toBe(
      REDACTED,
    );
    expect(r.redactString('key AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED);
    // Visa test number that passes Luhn.
    expect(r.redactString('pay with 4111 1111 1111 1111 please')).toContain(REDACTED);
    expect(r.redactString('not a card 1234 5678 9012')).not.toContain(REDACTED);
  });

  it('supports custom redactors and key patterns', () => {
    const r = createRedactor({
      keys: ['nationalId'],
      custom: [(value, ctx) => (ctx.key === 'nickname' && value === 'hide-me' ? 'xxx' : undefined)],
    });
    expect(r.redact({ nationalId: '123', nickname: 'hide-me', keep: 1 })).toEqual({
      nationalId: REDACTED,
      nickname: 'xxx',
      keep: 1,
    });
  });

  it('redacts before hashing and storage', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const event = await audit.record({
      action: 'users.secret.rotate',
      changes: {
        before: { apiKey: 'old-key', name: 'a' },
        after: { apiKey: 'new-key', name: 'b' },
      },
      metadata: { password: 'p', note: 'safe' },
    });
    expect(event.changes?.before).toEqual({ apiKey: REDACTED, name: 'a' });
    expect(event.changes?.after).toEqual({ apiKey: REDACTED, name: 'b' });
    expect(event.metadata).toEqual({ password: REDACTED, note: 'safe' });
    expect(event.changes?.diff.some((d) => d.path === 'apiKey')).toBe(true);
    for (const d of event.changes?.diff ?? []) {
      if (d.path === 'apiKey') {
        expect(d.before).toBe(REDACTED);
        expect(d.after).toBe(REDACTED);
      }
    }
  });
});
