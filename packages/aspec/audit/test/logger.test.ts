import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runWithAuditContext } from '../src/context.js';
import { AuditError } from '../src/errors.js';
import { createAuditLogger } from '../src/logger.js';
import { createMemoryAuditStore } from '../src/stores/memory.js';

function hmacKey(): string {
  return randomBytes(32).toString('hex');
}

describe('createAuditLogger', () => {
  it('normalises actor, action, resource, timestamps and correlation', async () => {
    const store = createMemoryAuditStore();
    let t = 1_700_000_000_000;
    const audit = createAuditLogger({
      sink: store,
      clock: { now: () => t++ },
      generateId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    const event = await audit.record({
      action: 'users.profile.update',
      outcome: 'success',
      actor: { id: 'u1', type: 'user', ip: '10.0.0.1' },
      resource: { type: 'user', id: 'u1' },
      tenantId: 't1',
      requestId: 'req-1',
      changes: { before: { name: 'A' }, after: { name: 'B' } },
      metadata: { reason: 'self-service' },
    });
    expect(event.id).toBe('id-1');
    expect(event.timestamp).toBe(1_700_000_000_000);
    expect(event.time).toBe(new Date(1_700_000_000_000).toISOString());
    expect(event.action).toBe('users.profile.update');
    expect(event.outcome).toBe('success');
    expect(event.category).toBe('system');
    expect(event.security).toBe(false);
    expect(event.actor).toEqual({ id: 'u1', type: 'user', ip: '10.0.0.1' });
    expect(event.resource).toEqual({ type: 'user', id: 'u1' });
    expect(event.tenantId).toBe('t1');
    expect(event.requestId).toBe('req-1');
    expect(event.correlationId).toBe('req-1');
    expect(event.changes?.diff).toEqual([{ path: 'name', op: 'changed', before: 'A', after: 'B' }]);
    expect(event.stream).toBe('system:t1');
    expect(event.seq).toBe(1);
    expect(event.prevHash).toHaveLength(64);
    expect(event.hash).toHaveLength(64);
  });

  it('flags security category for auth prefixes and denied outcomes', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const a = await audit.record({ action: 'auth.login.failed', outcome: 'failure' });
    expect(a.category).toBe('security');
    expect(a.security).toBe(true);
    const b = await audit.record({ action: 'users.read', outcome: 'denied' });
    expect(b.category).toBe('security');
    const c = await audit.recordSecurityEvent({ action: 'admin.policy.change' });
    expect(c.category).toBe('security');
  });

  it('rejects invalid actions', async () => {
    const audit = createAuditLogger({ sink: createMemoryAuditStore() });
    await expect(audit.record({ action: 'nons' })).rejects.toMatchObject({
      code: 'AUDIT_INVALID_EVENT',
    });
  });

  it('enriches from AsyncLocalStorage context', async () => {
    const audit = createAuditLogger({ sink: createMemoryAuditStore() });
    const event = await runWithAuditContext(
      {
        requestId: 'r1',
        correlationId: 'c1',
        ip: '203.0.113.9',
        userAgent: 'vitest',
        tenantId: 'ten',
        resolveActor: () => ({ id: 'actor-1', type: 'user' }),
      },
      () => audit.record({ action: 'app.page.view' }),
    );
    expect(event.requestId).toBe('r1');
    expect(event.correlationId).toBe('c1');
    expect(event.tenantId).toBe('ten');
    expect(event.actor).toMatchObject({ id: 'actor-1', ip: '203.0.113.9', userAgent: 'vitest' });
  });

  it('implements AuditSink.record', async () => {
    const audit = createAuditLogger({ sink: createMemoryAuditStore() });
    const sink: { record: (e: { action: string }) => Promise<unknown> } = audit;
    const event = await sink.record({ action: 'jobs.worker.start' });
    expect(event).toMatchObject({ action: 'jobs.worker.start' });
  });

  it('requires a store for query and verify', async () => {
    const audit = createAuditLogger({
      sink: { name: 'noop', write: async () => {} },
    });
    await expect(audit.query()).rejects.toBeInstanceOf(AuditError);
    await expect(audit.verifyChain('system')).rejects.toMatchObject({
      code: 'AUDIT_NOT_QUERYABLE',
    });
  });

  it('supports HMAC chain and Ed25519 checkpoints', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({
      sink: store,
      chain: {
        hmacKey: hmacKey(),
        signingKey: privateKey,
        verifyKey: publicKey,
      },
    });
    await audit.record({ action: 'auth.login.success' });
    await audit.record({ action: 'auth.logout' });
    const cp = await audit.createCheckpoint('security');
    expect(cp.mac).toBeTruthy();
    expect(cp.signature).toBeTruthy();
    const report = await audit.verifyChain('security');
    expect(report.ok).toBe(true);
  });
});
