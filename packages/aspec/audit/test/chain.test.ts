import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuditLogger } from '../src/logger.js';
import { createMemoryAuditStore } from '../src/stores/memory.js';
import type { AuditEvent } from '../src/types.js';

function hmacKey(): Buffer {
  return randomBytes(32);
}

async function seed(n: number, hmac?: Buffer) {
  const store = createMemoryAuditStore();
  const audit = createAuditLogger({
    sink: store,
    ...(hmac ? { chain: { hmacKey: hmac } } : {}),
    retention: { defaultDays: 90, categories: { security: 365 } },
  });
  for (let i = 0; i < n; i++) {
    await audit.record({ action: 'auth.login.success', metadata: { i } });
  }
  return { store, audit };
}

describe('hash chain verification', () => {
  it('detects modification', async () => {
    const { store, audit } = await seed(3);
    const events = store.all();
    const victim = structuredClone(events[1] as AuditEvent);
    victim.metadata = { i: 99 };
    // Keep the original hash so the content/hash mismatch is detectable.
    store.clear();
    await store.write(events.map((e) => (e.id === victim.id ? victim : e)));
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'modified')).toBe(true);
  });

  it('detects deletion', async () => {
    const { store, audit } = await seed(4);
    const events = store.all();
    const remove = events[1] as AuditEvent;
    store.clear();
    for (const e of events) {
      if (e.id !== remove.id) await store.write([e]);
    }
    // restore heads for remaining
    for (const e of store.all()) {
      // appendChained not used; rewrite via write already updated heads in insert
      void e;
    }
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'deleted')).toBe(true);
  });

  it('detects insertion of a duplicate sequence', async () => {
    const { store, audit } = await seed(2);
    const clone = structuredClone(store.all()[0] as AuditEvent);
    clone.id = 'forged-id';
    await store.write([clone]);
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'inserted')).toBe(true);
  });

  it('detects reordering in storage', async () => {
    const { store, audit } = await seed(3);
    const events = store.all();
    store.clear();
    await store.write([events[2] as AuditEvent, events[0] as AuditEvent, events[1] as AuditEvent]);
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'reordered' || i.kind === 'broken-link')).toBe(
      true,
    );
  });

  it('verifies HMAC-protected chains and rejects downgrades', async () => {
    const key = hmacKey();
    const { store, audit } = await seed(2, key);
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(true);
    expect(store.all()[0]?.hashAlg).toBe('hmac-sha256');

    const plain = createMemoryAuditStore();
    const plainAudit = createAuditLogger({ sink: plain });
    await plainAudit.record({ action: 'auth.login.success' });
    const mixed = createMemoryAuditStore();
    const mixedAudit = createAuditLogger({ sink: mixed, chain: { hmacKey: key } });
    await mixed.write(plain.all());
    await mixedAudit.record({ action: 'auth.logout' });
    const bad = await mixedAudit.verifyChain('security');
    expect(bad.ok).toBe(false);
  });

  it('keeps chain verifiable across retention with checkpoints', async () => {
    let now = Date.now();
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({
      sink: store,
      clock: { now: () => now },
      retention: { defaultDays: 1, categories: { security: 1 } },
    });
    await audit.record({ action: 'auth.login.success' });
    now += 3 * 86_400_000;
    await audit.record({ action: 'auth.logout' });
    const result = await audit.applyRetention({ now });
    expect(result.purged).toBe(1);
    expect(result.streams[0]?.checkpoint?.kind).toBe('retention');
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(true);
    expect(report.anchor.kind).toBe('checkpoint');
  });
});
