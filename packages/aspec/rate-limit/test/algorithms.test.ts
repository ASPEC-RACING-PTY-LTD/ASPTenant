import { afterEach, describe, expect, it } from 'vitest';
import { applyAlgorithm, normalizePolicy, policyWindowSeconds } from '../src/algorithms.js';
import { RateLimitError } from '../src/errors.js';
import { createRateLimiter } from '../src/limiter.js';
import { createMemoryStore, type MemoryRateLimitStore } from '../src/stores/memory.js';
import { type FakeClock, fakeClock } from './helpers.js';

let store: MemoryRateLimitStore;
let clock: FakeClock;

function limiter(policy: Parameters<typeof createRateLimiter>[0]['policy']) {
  clock = fakeClock(1_000_000_020_000);
  store = createMemoryStore({ clock });
  return createRateLimiter({ store, policy, clock });
}

afterEach(async () => {
  await store?.close();
});

describe('policy validation', () => {
  it('applies defaults', () => {
    expect(normalizePolicy({ limit: 10, windowMs: 1000 })).toEqual({
      name: 'default',
      algorithm: 'sliding-window',
      limit: 10,
      windowMs: 1000,
      burst: 10,
      cost: 1,
    });
  });

  it('rejects invalid options with a descriptive error naming the option', () => {
    expect(() => normalizePolicy({ limit: 0, windowMs: 1000 })).toThrow(/policy\.limit/);
    expect(() => normalizePolicy({ limit: 1, windowMs: 1.5 })).toThrow(/policy\.windowMs/);
    expect(() => normalizePolicy({ name: 'bad name', limit: 1, windowMs: 1 })).toThrow(
      /policy\.name/,
    );
    expect(() => normalizePolicy({ algorithm: 'leaky' as 'gcra', limit: 1, windowMs: 1 })).toThrow(
      /policy\.algorithm/,
    );
    expect(() =>
      normalizePolicy({ algorithm: 'sliding-log', limit: 20_000, windowMs: 1000 }),
    ).toThrow(/policy\.limit/);
    expect(() => normalizePolicy({ limit: 5, windowMs: 1000, cost: 6 })).toThrow(/policy\.cost/);
    try {
      normalizePolicy({ limit: -1, windowMs: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).code).toBe('RATE_LIMIT_INVALID_CONFIG');
    }
  });

  it('computes the quota window for headers', () => {
    expect(policyWindowSeconds(normalizePolicy({ limit: 100, windowMs: 60_000 }))).toBe(60);
    expect(
      policyWindowSeconds(
        normalizePolicy({ algorithm: 'token-bucket', limit: 10, windowMs: 1000, burst: 50 }),
      ),
    ).toBe(5);
  });
});

describe('token bucket', () => {
  it('allows a burst up to capacity and then refills at the configured rate', async () => {
    const rl = limiter({ algorithm: 'token-bucket', limit: 1, windowMs: 1000, burst: 5 });
    for (let i = 0; i < 5; i++) {
      const d = await rl.consume('k');
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(4 - i);
      expect(d.limit).toBe(5);
    }
    const denied = await rl.consume('k');
    expect(denied).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1000,
      reason: 'limit',
    });
    clock.advance(999);
    expect((await rl.consume('k')).allowed).toBe(false);
    clock.advance(1);
    const refilled = await rl.consume('k');
    expect(refilled.allowed).toBe(true);
    expect(refilled.remaining).toBe(0);
    clock.advance(10_000);
    expect((await rl.peek('k')).remaining).toBe(5);
  });

  it('reports resetAt as the time the bucket is full again', async () => {
    const rl = limiter({ algorithm: 'token-bucket', limit: 2, windowMs: 1000, burst: 4 });
    const d = await rl.consume('k', 3);
    expect(d.remaining).toBe(1);
    expect(d.resetAt - clock.now()).toBe(1500);
    expect(d.resetAfterMs).toBe(1500);
  });

  it('computes retry for costs greater than the remaining tokens', async () => {
    const rl = limiter({ algorithm: 'token-bucket', limit: 10, windowMs: 1000, burst: 10 });
    await rl.consume('k', 8);
    const d = await rl.consume('k', 5);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(2);
    expect(d.retryAfterMs).toBe(300);
  });
});

describe('gcra', () => {
  it('allows bursts and spaces requests at the emission interval', async () => {
    const rl = limiter({ algorithm: 'gcra', limit: 10, windowMs: 1000, burst: 3 });
    expect((await rl.consume('k')).remaining).toBe(2);
    expect((await rl.consume('k')).remaining).toBe(1);
    expect((await rl.consume('k')).remaining).toBe(0);
    const denied = await rl.consume('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(100);
    clock.advance(100);
    expect((await rl.consume('k')).allowed).toBe(true);
    expect((await rl.consume('k')).allowed).toBe(false);
    clock.advance(1000);
    expect((await rl.peek('k')).remaining).toBe(3);
  });
});

describe('fixed window', () => {
  it('counts per aligned window and resets at the boundary', async () => {
    const rl = limiter({ algorithm: 'fixed-window', limit: 3, windowMs: 10_000 });
    const first = await rl.consume('k');
    expect(first.resetAt % 10_000).toBe(0);
    await rl.consume('k');
    await rl.consume('k');
    const denied = await rl.consume('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(denied.resetAt - clock.now());
    clock.t = denied.resetAt;
    expect((await rl.consume('k')).remaining).toBe(2);
  });

  it('does not consume on denied requests', async () => {
    const rl = limiter({ algorithm: 'fixed-window', limit: 2, windowMs: 10_000 });
    await rl.consume('k');
    expect((await rl.consume('k', 2)).allowed).toBe(false);
    expect((await rl.consume('k')).allowed).toBe(true);
  });
});

describe('sliding window counter', () => {
  it('weights the previous window by the remaining overlap', async () => {
    const rl = limiter({ algorithm: 'sliding-window', limit: 10, windowMs: 10_000 });
    clock.t = 1_000_000_000_000; // window boundary
    for (let i = 0; i < 10; i++) expect((await rl.consume('k')).allowed).toBe(true);
    expect((await rl.consume('k')).allowed).toBe(false);
    clock.advance(12_500); // 25% into the next window: previous weight 0.75 -> estimate 7.5
    const d = await rl.consume('k');
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(1);
    await rl.consume('k');
    const denied = await rl.consume('k');
    expect(denied.allowed).toBe(false);
    // estimate 7.5 + 2 = 9.5; need <= 9 -> previous contribution must drop to 7 -> 0.7 weight
    expect(denied.retryAfterMs).toBe(500);
    clock.advance(500);
    expect((await rl.consume('k')).allowed).toBe(true);
  });

  it('computes retry into the next window when the current window is full', () => {
    const cfg = { algorithm: 'sliding-window' as const, limit: 4, windowMs: 1000, burst: 4 };
    const step = applyAlgorithm(cfg, { window: 5, count: 4, prev: 0 }, 1, 5_000 + 200, 'consume');
    expect(step.result.allowed).toBe(false);
    // next window: previous = 4, allowed when 4 * (1 - e) <= 3 -> e >= 250 ms
    expect(step.result.retryAfterMs).toBe(800 + 250);
  });
});

describe('sliding log', () => {
  it('is exact over a rolling window', async () => {
    const rl = limiter({ algorithm: 'sliding-log', limit: 3, windowMs: 1000 });
    await rl.consume('k');
    clock.advance(300);
    await rl.consume('k');
    clock.advance(300);
    await rl.consume('k');
    const denied = await rl.consume('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(400);
    clock.advance(400);
    expect((await rl.consume('k')).allowed).toBe(true);
    expect((await rl.consume('k')).allowed).toBe(false);
  });
});

describe('peek, reset, penalize', () => {
  it('peek does not consume', async () => {
    const rl = limiter({ algorithm: 'fixed-window', limit: 2, windowMs: 1000 });
    expect((await rl.peek('k')).remaining).toBe(2);
    expect((await rl.peek('k')).remaining).toBe(2);
    await rl.consume('k');
    expect((await rl.peek('k')).remaining).toBe(1);
  });

  it('reset clears the counter', async () => {
    const rl = limiter({ algorithm: 'token-bucket', limit: 1, windowMs: 60_000 });
    await rl.consume('k');
    expect((await rl.consume('k')).allowed).toBe(false);
    await rl.reset('k');
    expect((await rl.consume('k')).allowed).toBe(true);
  });

  it('penalize consumes beyond the limit', async () => {
    for (const algorithm of [
      'token-bucket',
      'gcra',
      'fixed-window',
      'sliding-window',
      'sliding-log',
    ] as const) {
      const rl = limiter({ algorithm, limit: 5, windowMs: 60_000 });
      const d = await rl.penalize('k', 5);
      expect(d.allowed, algorithm).toBe(false);
      expect(d.remaining, algorithm).toBe(0);
      expect(d.retryAfterMs, algorithm).toBeGreaterThan(0);
      expect((await rl.consume('k')).allowed, algorithm).toBe(false);
      await store.close();
    }
  });

  it('isolates keys and policies', async () => {
    clock = fakeClock();
    store = createMemoryStore({ clock });
    const a = createRateLimiter({ store, policy: { name: 'a', limit: 1, windowMs: 1000 } });
    const b = createRateLimiter({ store, policy: { name: 'b', limit: 1, windowMs: 1000 } });
    expect((await a.consume('x')).allowed).toBe(true);
    expect((await a.consume('y')).allowed).toBe(true);
    expect((await b.consume('x')).allowed).toBe(true);
    expect((await a.consume('x')).allowed).toBe(false);
  });

  it('validates keys and costs', async () => {
    const rl = limiter({ limit: 5, windowMs: 1000 });
    await expect(rl.consume('')).rejects.toMatchObject({ code: 'RATE_LIMIT_INVALID_ARGUMENT' });
    await expect(rl.consume('k', 0)).rejects.toMatchObject({ code: 'RATE_LIMIT_INVALID_ARGUMENT' });
    await expect(rl.consume('x'.repeat(600))).rejects.toMatchObject({
      code: 'RATE_LIMIT_INVALID_ARGUMENT',
    });
    expect((await rl.consume('x'.repeat(300))).allowed).toBe(true);
  });
});

describe('memory store bounds', () => {
  it('evicts least recently used keys beyond maxKeys and sweeps expired entries', async () => {
    clock = fakeClock();
    store = createMemoryStore({ clock, maxKeys: 3 });
    const rl = createRateLimiter({
      store,
      policy: { algorithm: 'fixed-window', limit: 1, windowMs: 1000 },
    });
    for (const k of ['a', 'b', 'c', 'd']) await rl.consume(k);
    expect(store.size()).toBe(3);
    expect((await rl.consume('a')).allowed).toBe(true); // evicted, so fresh
    clock.advance(5000);
    store.sweep();
    expect(store.size()).toBe(0);
  });

  it('validates options', () => {
    expect(() => createMemoryStore({ maxKeys: 0 })).toThrow(/maxKeys/);
    expect(() => createMemoryStore({ sweepIntervalMs: 10 })).toThrow(/sweepIntervalMs/);
  });
});
