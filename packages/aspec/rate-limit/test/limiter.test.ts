import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitExceededError } from '../src/errors.js';
import { type BanEvent, createRateLimiter, type LimitReachedEvent } from '../src/limiter.js';
import type { AuditEventInput } from '../src/ports.js';
import { createMemoryStore, type MemoryRateLimitStore } from '../src/stores/memory.js';
import { failingStore, fakeClock, recordingLogger } from './helpers.js';

let store: MemoryRateLimitStore | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

describe('limit() for non-HTTP operations', () => {
  it('throws RateLimitExceededError with retry information', async () => {
    const clock = fakeClock();
    store = createMemoryStore({ clock });
    const rl = createRateLimiter({
      store,
      clock,
      policy: { name: 'emails', algorithm: 'fixed-window', limit: 1, windowMs: 60_000 },
    });
    await rl.limit('user:1');
    const error = await rl.limit('user:1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitExceededError);
    const e = error as RateLimitExceededError;
    expect(e.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(e.status).toBe(429);
    expect(e.expose).toBe(true);
    expect(e.retryAfterMs).toBeGreaterThan(0);
    expect(e.message).toMatch(/Retry after \d+ seconds/);
  });

  it('satisfies the RateLimiterLike port', async () => {
    store = createMemoryStore();
    const port: { consume(key: string, cost?: number): Promise<{ allowed: boolean }> } =
      createRateLimiter({ store, policy: { limit: 1, windowMs: 1000 } });
    expect((await port.consume('a')).allowed).toBe(true);
  });
});

describe('penalty box', () => {
  it('bans after repeated violations with escalating duration', async () => {
    const clock = fakeClock();
    store = createMemoryStore({ clock });
    const bans: BanEvent[] = [];
    const reached: LimitReachedEvent[] = [];
    const audit: AuditEventInput[] = [];
    const rl = createRateLimiter({
      store,
      clock,
      policy: { name: 'login', algorithm: 'fixed-window', limit: 1, windowMs: 1000 },
      penalty: {
        threshold: 3,
        violationWindowMs: 10_000,
        banMs: 5000,
        multiplier: 3,
        maxBanMs: 20_000,
      },
      onBan: (e) => {
        bans.push(e);
      },
      onLimitReached: (e) => {
        reached.push(e);
      },
      audit: {
        async record(event) {
          audit.push(event);
        },
      },
    });
    await rl.consume('ip:1');
    await rl.consume('ip:1');
    await rl.consume('ip:1');
    const third = await rl.consume('ip:1');
    expect(third.reason).toBe('banned');
    expect(third.retryAfterMs).toBe(5000);
    expect(reached).toHaveLength(3);
    expect(bans).toEqual([
      {
        key: 'ip:1',
        policy: 'login',
        until: clock.now() + 5000,
        level: 1,
        durationMs: 5000,
        manual: false,
      },
    ]);
    expect(audit[0]).toMatchObject({ action: 'rate_limit.banned', category: 'security' });

    clock.advance(4000);
    const stillBanned = await rl.consume('ip:1');
    expect(stillBanned).toMatchObject({ allowed: false, reason: 'banned', retryAfterMs: 1000 });

    clock.advance(1000);
    expect((await rl.consume('ip:1')).allowed).toBe(true);
    for (let i = 0; i < 3; i++) await rl.consume('ip:1');
    expect(bans[1]).toMatchObject({ level: 2, durationMs: 15_000 });

    clock.advance(15_000);
    await rl.consume('ip:1');
    for (let i = 0; i < 3; i++) await rl.consume('ip:1');
    expect(bans[2]).toMatchObject({ level: 3, durationMs: 20_000 }); // capped by maxBanMs
  });

  it('supports manual ban and unban', async () => {
    const clock = fakeClock();
    store = createMemoryStore({ clock });
    const rl = createRateLimiter({
      store,
      clock,
      policy: { limit: 100, windowMs: 1000 },
      checkBans: true,
    });
    const ban = await rl.ban('user:9', 30_000);
    expect(ban).toEqual({ until: clock.now() + 30_000, level: 1 });
    expect(await rl.getBan('user:9')).toEqual(ban);
    expect((await rl.consume('user:9')).reason).toBe('banned');
    await rl.unban('user:9');
    expect((await rl.consume('user:9')).allowed).toBe(true);
  });

  it('isolates hook failures', async () => {
    store = createMemoryStore();
    const logger = recordingLogger();
    const rl = createRateLimiter({
      store,
      logger,
      policy: { algorithm: 'fixed-window', limit: 1, windowMs: 60_000 },
      onLimitReached: () => {
        throw new Error('hook broke');
      },
    });
    await rl.consume('k');
    expect((await rl.consume('k')).allowed).toBe(false);
    expect(logger.entries.some((e) => e.msg === 'hook failed')).toBe(true);
  });
});

describe('allowlist and denylist', () => {
  it('matches exact keys and IP keys inside CIDR ranges', async () => {
    store = createMemoryStore();
    const rl = createRateLimiter({
      store,
      policy: { algorithm: 'fixed-window', limit: 1, windowMs: 60_000 },
      allowlist: { ips: ['10.0.0.0/8'], keys: ['user:admin'] },
      denylist: { ips: ['203.0.113.0/24', '2001:db8::/32'], keys: ['user:evil'] },
    });
    for (let i = 0; i < 3; i++) {
      expect((await rl.consume('ip:10.1.2.3')).reason).toBe('allowlist');
      expect((await rl.consume('user:admin')).allowed).toBe(true);
    }
    expect((await rl.consume('ip:203.0.113.9')).reason).toBe('denylist');
    expect((await rl.consume('2001:db8:1::5')).reason).toBe('denylist');
    expect((await rl.consume('user:evil')).allowed).toBe(false);
    expect((await rl.consume('ip:192.0.2.1')).allowed).toBe(true);
  });

  it('rejects invalid entries at construction', () => {
    store = createMemoryStore();
    expect(() =>
      createRateLimiter({
        store: store as MemoryRateLimitStore,
        policy: { limit: 1, windowMs: 1 },
        denylist: { ips: ['nope'] },
      }),
    ).toThrow(/denylist\.ips/);
    expect(() =>
      createRateLimiter({
        store: store as MemoryRateLimitStore,
        policy: { limit: 1, windowMs: 1 },
        allowlist: { ips: ['10.0.0.0/33'] },
      }),
    ).toThrow(/prefix length/);
  });
});

describe('failure handling', () => {
  it('fails open by default and logs the store error', async () => {
    const logger = recordingLogger();
    const rl = createRateLimiter({
      store: failingStore(),
      logger,
      policy: { limit: 5, windowMs: 1000 },
    });
    const d = await rl.consume('k');
    expect(d).toMatchObject({ allowed: true, reason: 'fail_open', remaining: 5 });
    expect(logger.entries[0]).toMatchObject({ level: 'warn', msg: 'rate-limit store error' });
    expect(JSON.stringify(logger.entries)).toContain('connection refused');
  });

  it('fails closed when configured', async () => {
    const rl = createRateLimiter({
      store: failingStore(),
      failureMode: 'closed',
      policy: { limit: 5, windowMs: 1000 },
    });
    const d = await rl.consume('k');
    expect(d).toMatchObject({ allowed: false, reason: 'store_unavailable' });
    expect(d.retryAfterMs).toBeGreaterThanOrEqual(1000);
    await expect(rl.limit('k')).rejects.toMatchObject({ status: 503 });
  });

  it('opens the circuit so a dead store is not called on every request', async () => {
    const clock = fakeClock();
    const dead = failingStore();
    const logger = recordingLogger();
    const rl = createRateLimiter({
      store: dead,
      clock,
      logger,
      policy: { limit: 5, windowMs: 1000 },
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
    });
    for (let i = 0; i < 10; i++) await rl.consume('k');
    expect(dead.calls).toBe(3);
    expect(rl.circuitState).toBe('open');
    expect(logger.entries.filter((e) => e.msg === 'rate-limit store error')).toHaveLength(2);
    expect(logger.entries.some((e) => e.msg === 'rate-limit store circuit opened')).toBe(true);
    clock.advance(10_000);
    expect(rl.circuitState).toBe('half-open');
    await rl.consume('k');
    expect(dead.calls).toBe(4);
    expect(rl.circuitState).toBe('open');
  });

  it('closes the circuit again after a successful trial call', async () => {
    const clock = fakeClock();
    const healthy = createMemoryStore({ clock });
    store = healthy;
    let broken = true;
    const flaky = {
      ...healthy,
      apply: (op: Parameters<typeof healthy.apply>[0]) =>
        broken ? Promise.reject(new Error('down')) : healthy.apply(op),
    };
    const rl = createRateLimiter({
      store: flaky,
      clock,
      policy: { limit: 5, windowMs: 1000 },
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1000 },
    });
    await rl.consume('k');
    expect(rl.circuitState).toBe('open');
    broken = false;
    clock.advance(1000);
    expect((await rl.consume('k')).reason).toBeUndefined();
    expect(rl.circuitState).toBe('closed');
  });

  it('treats slow store calls as failures', async () => {
    const rl = createRateLimiter({
      store: failingStore('hang'),
      policy: { limit: 5, windowMs: 1000 },
      circuitBreaker: { timeoutMs: 20 },
      failureMode: 'closed',
    });
    const started = Date.now();
    const d = await rl.consume('k');
    expect(d.reason).toBe('store_unavailable');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('validates options', () => {
    expect(() =>
      createRateLimiter({
        store: failingStore(),
        policy: { limit: 1, windowMs: 1 },
        failureMode: 'x' as 'open',
      }),
    ).toThrow(/failureMode/);
    expect(() =>
      createRateLimiter({ store: {} as never, policy: { limit: 1, windowMs: 1 } }),
    ).toThrow(/store/);
    expect(() =>
      createRateLimiter({
        store: failingStore(),
        policy: { limit: 1, windowMs: 1 },
        penalty: { banMs: 10, maxBanMs: 5 },
      }),
    ).toThrow(/maxBanMs/);
  });
});
