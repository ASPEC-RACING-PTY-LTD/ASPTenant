import { afterEach, describe, expect, it } from 'vitest';
import { createApiKeys } from '../src/service.js';
import { createMemoryStore } from '../src/stores/memory.js';

const PEPPER = Buffer.alloc(32, 9);

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('api-keys service', () => {
  const stores: { shutdown(): Promise<void> }[] = [];
  afterEach(async () => {
    while (stores.length) await stores.pop()!.shutdown();
  });

  function setup(clock = fakeClock()) {
    const store = createMemoryStore();
    const api = createApiKeys({
      store,
      pepper: PEPPER,
      clock,
      nodeEnv: 'test',
      usageFlushIntervalMs: 0,
      verificationFailureSampleRate: 0,
    });
    stores.push(api);
    return { api, store, clock };
  }

  it('creates a key and never stores plaintext', async () => {
    const { api, store } = setup();
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    expect(created.secret).toMatch(/^ak_live_/);
    const record = await store.getKeyById(created.key.id);
    expect(record!.keyHash).not.toContain(created.secret);
    expect(JSON.stringify(record)).not.toContain(created.secret);
  });

  it('verifies valid keys and rejects unknown ids with dummy compare path', async () => {
    const { api } = setup();
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const ok = await api.verify(created.secret);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.principal.scopes).toEqual(['read:data']);
    const bad = await api.verify(
      'ak_live_zzzzzzzz_abcdefghijklmnopqrstuvwxyz0123456789abcdefXXXXXX',
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(401);
  });

  it('enforces scopes', async () => {
    const { api } = setup();
    const created = await api.create({
      name: 'ci',
      scopes: ['read:*'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const ok = await api.verify(created.secret, { scopes: ['read:users'] });
    expect(ok.ok).toBe(true);
    const denied = await api.verify(created.secret, { scopes: ['write:users'] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);
  });

  it('expires keys with the injected clock', async () => {
    const clock = fakeClock();
    const { api } = setup(clock);
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
      ttlMs: 1000,
    });
    expect((await api.verify(created.secret)).ok).toBe(true);
    clock.advance(1001);
    const failed = await api.verify(created.secret);
    expect(failed.ok).toBe(false);
  });

  it('rotates with grace period', async () => {
    const clock = fakeClock();
    const { api } = setup(clock);
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const rotated = await api.rotate(created.key.id, { gracePeriodMs: 5000 });
    expect((await api.verify(rotated.secret)).ok).toBe(true);
    expect((await api.verify(created.secret)).ok).toBe(true);
    clock.advance(5001);
    expect((await api.verify(created.secret)).ok).toBe(false);
    expect((await api.verify(rotated.secret)).ok).toBe(true);
  });

  it('revokes immediately and invalidates cache', async () => {
    const cache = new Map<string, unknown>();
    const store = createMemoryStore();
    const api = createApiKeys({
      store,
      pepper: PEPPER,
      nodeEnv: 'test',
      usageFlushIntervalMs: 0,
      verificationFailureSampleRate: 0,
      cache: {
        async get(key) {
          return cache.get(key) as never;
        },
        async set(key, value) {
          cache.set(key, value);
        },
        async delete(key) {
          cache.delete(key);
        },
      },
    });
    stores.push(api);
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    expect((await api.verify(created.secret)).ok).toBe(true);
    expect(cache.size).toBeGreaterThan(0);
    await api.revoke(created.key.id, { reason: 'leak', actor: 'admin' });
    expect(cache.size).toBe(0);
    expect((await api.verify(created.secret)).ok).toBe(false);
  });

  it('batches usage and flushes on shutdown', async () => {
    const { api, store } = setup();
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    await api.verify(created.secret, { ip: '1.2.3.4' });
    await api.verify(created.secret, { ip: '1.2.3.4' });
    await api.shutdown();
    const record = await store.getKeyById(created.key.id);
    expect(record!.useCount).toBe(2);
    expect(record!.lastUsedIp).toBe('1.2.3.4');
  });

  it('disables keys when the service account is disabled', async () => {
    const { api } = setup();
    const sa = await api.createServiceAccount({ name: 'bot' });
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'service_account',
      ownerId: sa.id,
    });
    expect((await api.verify(created.secret)).ok).toBe(true);
    await api.updateServiceAccount(sa.id, { enabled: false });
    expect((await api.verify(created.secret)).ok).toBe(false);
  });

  it('blocks scope escalation without allowEscalation', async () => {
    const { api } = setup();
    const created = await api.create({
      name: 'ci',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    await expect(
      api.update(created.key.id, { scopes: ['read:data', 'write:data'] }),
    ).rejects.toMatchObject({ code: 'API_KEYS_ESCALATION' });
    const updated = await api.update(created.key.id, {
      scopes: ['read:data', 'write:data'],
      allowEscalation: true,
    });
    expect(updated.scopes).toContain('write:data');
  });

  it('lists expiringWithin', async () => {
    const clock = fakeClock();
    const { api } = setup(clock);
    await api.create({
      name: 'soon',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
      ttlMs: 2 * 86_400_000,
    });
    await api.create({
      name: 'later',
      scopes: ['read:data'],
      ownerType: 'user',
      ownerId: 'u1',
      ttlMs: 30 * 86_400_000,
    });
    const page = await api.expiringWithin(3);
    expect(page.items.map((k) => k.name)).toEqual(['soon']);
  });
});
