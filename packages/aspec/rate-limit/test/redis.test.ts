import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Algorithm } from '../src/algorithms.js';
import { createRateLimiter } from '../src/limiter.js';
import {
  createRedisStore,
  fromIoredis,
  fromNodeRedis,
  type RedisScriptClient,
} from '../src/stores/redis.js';
import { fakeClock } from './helpers.js';

const url = process.env.ASPEC_TEST_REDIS_URL;

interface ClientCase {
  name: string;
  connect(): Promise<{ script: RedisScriptClient; raw: unknown; close(): Promise<void> }>;
}

const clients: ClientCase[] = [
  {
    name: 'ioredis',
    async connect() {
      const raw = new Redis(url as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await raw.connect();
      return { script: fromIoredis(raw), raw, close: async () => void (await raw.quit()) };
    },
  },
  {
    name: 'node-redis',
    async connect() {
      const raw = createClient({ url: url as string });
      await raw.connect();
      return { script: fromNodeRedis(raw), raw, close: async () => void (await raw.quit()) };
    },
  },
];

describe.skipIf(!url)('Redis store (Valkey)', () => {
  let info: Redis;
  beforeAll(async () => {
    info = new Redis(url as string);
    const server = await info.info('server');
    const version = /(?:valkey|redis)_version:(\S+)/.exec(server)?.[1];
    console.log(`Redis-compatible server version: ${version}`);
  });
  afterAll(async () => {
    await info.quit();
  });

  describe.each(clients)('$name', (clientCase) => {
    let conn: Awaited<ReturnType<ClientCase['connect']>>;
    const prefix = `rltest:${randomBytes(4).toString('hex')}:`;
    beforeAll(async () => {
      conn = await clientCase.connect();
      await info.script('FLUSH'); // force the NOSCRIPT fallback path on first use
    });
    afterAll(async () => {
      const keys = await info.keys(`${prefix}*`);
      if (keys.length > 0) await info.del(...keys);
      await conn.close();
    });

    it('recovers from NOSCRIPT by loading the script', async () => {
      const store = createRedisStore({ client: conn.script, keyPrefix: prefix });
      const rl = createRateLimiter({ store, policy: { name: 'ns', limit: 2, windowMs: 1000 } });
      expect((await rl.consume('k')).allowed).toBe(true);
    });

    const cases: { algorithm: Algorithm; burst?: number }[] = [
      { algorithm: 'token-bucket', burst: 5 },
      { algorithm: 'gcra', burst: 5 },
      { algorithm: 'fixed-window' },
      { algorithm: 'sliding-window' },
      { algorithm: 'sliding-log' },
    ];

    it.each(cases)('$algorithm behaves like the reference implementation', async (c) => {
      const clock = fakeClock(1_700_000_000_000);
      const store = createRedisStore({ client: conn.script, keyPrefix: prefix, clock });
      const rl = createRateLimiter({
        store,
        clock,
        policy: {
          name: `alg-${c.algorithm}`,
          algorithm: c.algorithm,
          limit: 5,
          windowMs: 10_000,
          ...(c.burst ? { burst: c.burst } : {}),
        },
      });
      const key = randomBytes(4).toString('hex');
      const allowed: boolean[] = [];
      for (let i = 0; i < 6; i++) allowed.push((await rl.consume(key)).allowed);
      expect(allowed).toEqual([true, true, true, true, true, false]);
      const denied = await rl.consume(key);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.remaining).toBe(0);
      expect((await rl.peek(key)).allowed).toBe(false);
      clock.advance(20_000);
      const after = await rl.consume(key);
      expect(after.allowed).toBe(true);
      expect(after.remaining).toBe(4);
      await rl.reset(key);
      expect((await rl.peek(key)).remaining).toBe(5);
      const penalized = await rl.penalize(key, 5);
      expect(penalized.allowed).toBe(false);
    });

    it('matches exact retry values of the memory implementation', async () => {
      const clock = fakeClock(1_700_000_000_000);
      const store = createRedisStore({ client: conn.script, keyPrefix: prefix, clock });
      const rl = createRateLimiter({
        store,
        clock,
        policy: { name: 'exact', algorithm: 'token-bucket', limit: 10, windowMs: 1000 },
      });
      const key = randomBytes(4).toString('hex');
      await rl.consume(key, 8);
      const d = await rl.consume(key, 5);
      expect(d).toMatchObject({ allowed: false, remaining: 2, retryAfterMs: 300 });
    });

    it('uses server time by default', async () => {
      const store = createRedisStore({ client: conn.script, keyPrefix: prefix });
      const rl = createRateLimiter({
        store,
        policy: { name: 'time', algorithm: 'fixed-window', limit: 1, windowMs: 60_000 },
      });
      const d = await rl.consume(randomBytes(4).toString('hex'));
      expect(Math.abs(d.resetAt - Date.now())).toBeLessThanOrEqual(61_000);
      expect(d.resetAt % 60_000).toBe(0);
    });

    it('never exceeds the limit under concurrent consumers', async () => {
      const extra = await Promise.all([clientCase.connect(), clientCase.connect()]);
      try {
        const stores = [conn, ...extra].map((c) =>
          createRedisStore({ client: c.script, keyPrefix: prefix }),
        );
        for (const algorithm of [
          'token-bucket',
          'sliding-window',
          'sliding-log',
          'gcra',
        ] as const) {
          const limiters = stores.map((store) =>
            createRateLimiter({
              store,
              policy: { name: `conc-${algorithm}`, algorithm, limit: 25, windowMs: 60_000 },
            }),
          );
          const key = randomBytes(4).toString('hex');
          const results = await Promise.all(
            Array.from({ length: 150 }, (_, i) =>
              (limiters[i % limiters.length] as (typeof limiters)[number]).consume(key),
            ),
          );
          expect(results.filter((r) => r.allowed).length, algorithm).toBe(25);
          expect(results.every((r) => r.reason === undefined || r.reason === 'limit')).toBe(true);
        }
      } finally {
        await Promise.all(extra.map((c) => c.close()));
      }
    });

    it('stores penalty box bans with escalation', async () => {
      const clock = fakeClock(1_700_000_000_000);
      const store = createRedisStore({ client: conn.script, keyPrefix: prefix, clock });
      const rl = createRateLimiter({
        store,
        clock,
        policy: { name: 'pen', algorithm: 'fixed-window', limit: 1, windowMs: 1000 },
        penalty: { threshold: 2, banMs: 1000, multiplier: 2 },
      });
      const key = randomBytes(4).toString('hex');
      await rl.consume(key);
      await rl.consume(key);
      const banned = await rl.consume(key);
      expect(banned).toMatchObject({ reason: 'banned', retryAfterMs: 1000 });
      expect(await rl.getBan(key)).toEqual({ until: clock.now() + 1000, level: 1 });
      clock.advance(1000);
      await rl.consume(key);
      await rl.consume(key);
      const again = await rl.consume(key);
      expect(again.ban).toEqual({ until: clock.now() + 2000, level: 2 });
      await rl.unban(key);
      expect(await rl.getBan(key)).toBeUndefined();
      const manual = await rl.ban(key, 5000);
      // unban clears the escalation level, so a manual ban starts at level 1 again.
      expect(manual).toEqual({ until: clock.now() + 5000, level: 1 });
    });

    it('prefixes keys with a cluster hash tag and hashes long keys', async () => {
      const store = createRedisStore({ client: conn.script, keyPrefix: prefix });
      const rl = createRateLimiter({ store, policy: { name: 'tag', limit: 5, windowMs: 60_000 } });
      await rl.consume('user:42');
      await rl.consume('x'.repeat(300));
      const keys = (await info.keys(`${prefix}{tag:*`)).sort();
      expect(keys).toContain(`${prefix}{tag:user:42}`);
      expect(keys.some((k) => k.startsWith(`${prefix}{tag:h:`))).toBe(true);
      expect(await info.pttl(`${prefix}{tag:user:42}`)).toBeGreaterThan(0);
    });
  });

  it('validates options', () => {
    expect(() => createRedisStore({ client: {} as RedisScriptClient })).toThrow(/client/);
    expect(() =>
      createRedisStore({
        client: { evalSha: async () => [], scriptLoad: async () => '', del: async () => 0 },
        keyPrefix: 'bad prefix',
      }),
    ).toThrow(/keyPrefix/);
  });
});
