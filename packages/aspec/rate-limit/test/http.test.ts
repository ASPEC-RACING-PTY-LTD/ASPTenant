import { afterEach, describe, expect, it } from 'vitest';
import { createHttpRateLimiter, type HttpRequestInput, keys } from '../src/http.js';
import { createRateLimiter } from '../src/limiter.js';
import { createMemoryStore, type MemoryRateLimitStore } from '../src/stores/memory.js';
import { failingStore, fakeClock } from './helpers.js';

let store: MemoryRateLimitStore;
const clock = fakeClock(1_000_000_000_000);
afterEach(async () => {
  await store?.close();
});

function input(overrides: Partial<HttpRequestInput> & { headers?: Record<string, string> } = {}) {
  const hdrs = overrides.headers ?? {};
  return {
    method: 'GET',
    path: '/api/items',
    remoteAddress: '192.0.2.10',
    header: (name: string) => hdrs[name.toLowerCase()],
    raw: {},
    ...overrides,
  } satisfies HttpRequestInput;
}

function fixed(name: string, limit: number, windowMs = 60_000) {
  return createRateLimiter({
    store,
    clock,
    policy: { name, algorithm: 'fixed-window', limit, windowMs },
  });
}

describe('response headers', () => {
  it('emits IETF RateLimit-Policy and RateLimit fields in the exact draft format', async () => {
    clock.t = 999_999_980_000; // 20 s into a 60 s window
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({ limiter: fixed('default', 100) });
    const outcome = await http.evaluate(input());
    expect(outcome.action).toBe('allow');
    expect(outcome.headers).toEqual({
      'RateLimit-Policy': '"default";q=100;w=60',
      RateLimit: '"default";r=99;t=40',
    });
  });

  it('adds legacy headers and Retry-After on 429 with a problem+json body', async () => {
    clock.t = 999_999_980_000;
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({
      limiter: fixed('api', 1),
      headers: { legacy: true },
    });
    await http.evaluate(input());
    const outcome = await http.evaluate(input());
    expect(outcome.status).toBe(429);
    expect(outcome.headers).toEqual({
      'RateLimit-Policy': '"api";q=1;w=60',
      RateLimit: '"api";r=0;t=40',
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1000000020',
      'Retry-After': '40',
    });
    expect(outcome.body).toEqual({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Rate limit exceeded for policy "api". Retry after 40 seconds.',
      retryAfter: 40,
      policy: 'api',
    });
  });

  it('supports delta legacy reset, disabling headers and custom messages', async () => {
    store = createMemoryStore({ clock });
    clock.t = 999_999_980_000;
    const http = createHttpRateLimiter({
      limiter: fixed('x', 1),
      headers: { standard: false, legacy: true, legacyReset: 'delta', retryAfter: false },
      message: (s) => `Slow down for ${s}s`,
      problemType: 'https://example.com/problems/rate-limited',
    });
    await http.evaluate(input());
    const outcome = await http.evaluate(input());
    expect(outcome.headers).toEqual({
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '40',
    });
    expect(outcome.body?.detail).toBe('Slow down for 40s');
    expect(outcome.body?.type).toBe('https://example.com/problems/rate-limited');
  });
});

describe('multiple policies', () => {
  it('lists every policy and lets the most restrictive decision win', async () => {
    clock.t = 999_999_980_000;
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({
      rules: [
        { limiter: fixed('per-ip', 10), key: keys.ip() },
        { limiter: fixed('per-user', 2), key: keys.user() },
      ],
    });
    const req = input({ user: { id: 'u1' } });
    const first = await http.evaluate(req);
    expect(first.headers.RateLimit).toBe('"per-ip";r=9;t=40, "per-user";r=1;t=40');
    expect(first.headers['RateLimit-Policy']).toBe('"per-ip";q=10;w=60, "per-user";q=2;w=60');
    await http.evaluate(req);
    const third = await http.evaluate(req);
    expect(third.status).toBe(429);
    expect(third.decision?.policy).toBe('per-user');
    // Anonymous requests skip the user rule.
    const anon = await http.evaluate(input());
    expect(anon.action).toBe('allow');
    expect(anon.results.map((r) => r.policy)).toEqual(['per-ip']);
  });

  it('supports per-route costs and route keys', async () => {
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({
      rules: [{ limiter: fixed('route', 10), key: keys.route(keys.ip()), cost: () => 5 }],
    });
    expect((await http.evaluate(input())).decision?.remaining).toBe(5);
    expect((await http.evaluate(input({ path: '/other' }))).decision?.remaining).toBe(5);
    expect((await http.evaluate(input())).decision?.remaining).toBe(0);
  });
});

describe('client identification', () => {
  it('uses trusted proxy headers and groups IPv6 by /64', async () => {
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({ limiter: fixed('ip', 1), trustProxy: 'loopback' });
    const a = input({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '2001:db8:1:2::1' },
    });
    const b = input({
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '2001:db8:1:2::ffff' },
    });
    expect((await http.evaluate(a)).action).toBe('allow');
    expect((await http.evaluate(b)).action).toBe('reject');
    const spoofed = input({
      remoteAddress: '198.51.100.1',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    const spoofed2 = input({
      remoteAddress: '198.51.100.1',
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect((await http.evaluate(spoofed)).action).toBe('allow');
    expect((await http.evaluate(spoofed2)).action).toBe('reject');
  });

  it('hashes API keys so raw secrets never reach the store', async () => {
    const gen = keys.apiKey();
    const req = {
      ...input({ headers: { authorization: 'Bearer secret-token-value' } }),
      ip: undefined,
      ipKey: undefined,
      user: undefined,
    };
    const key = await gen(req);
    expect(key).toMatch(/^apikey:[A-Za-z0-9_-]{32}$/);
    expect(key).not.toContain('secret');
    expect(await gen({ ...req, header: () => undefined })).toBeUndefined();
  });
});

describe('abuse prevention', () => {
  it('rejects denylisted clients with 403 and bypasses allowlisted ones', async () => {
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({
      limiter: fixed('d', 1),
      allowlist: { ips: ['10.0.0.0/8'] },
      denylist: { ips: ['203.0.113.0/24'], keys: ['user:bad'] },
      rules: [{ limiter: fixed('users', 5), key: keys.user() }],
    });
    const denied = await http.evaluate(input({ remoteAddress: '203.0.113.50' }));
    expect(denied.status).toBe(403);
    expect(denied.headers).toEqual({});
    expect(denied.body?.title).toBe('Forbidden');
    expect((await http.evaluate(input({ user: { id: 'bad' } }))).status).toBe(403);
    for (let i = 0; i < 3; i++) {
      const ok = await http.evaluate(input({ remoteAddress: '10.9.9.9' }));
      expect(ok.action).toBe('allow');
      expect(ok.headers).toEqual({});
    }
  });

  it('returns 503 with Retry-After when a fail-closed store is down', async () => {
    const rl = createRateLimiter({
      store: failingStore(),
      failureMode: 'closed',
      policy: { name: 'auth', limit: 5, windowMs: 60_000 },
    });
    const outcome = await createHttpRateLimiter({ limiter: rl }).evaluate(input());
    expect(outcome.status).toBe(503);
    expect(outcome.headers['Retry-After']).toBeDefined();
    expect(outcome.body?.title).toBe('Service Unavailable');
  });

  it('skip() bypasses the limiter', async () => {
    store = createMemoryStore({ clock });
    const http = createHttpRateLimiter({
      limiter: fixed('s', 1),
      skip: (r) => r.path === '/health',
    });
    for (let i = 0; i < 3; i++) {
      expect((await http.evaluate(input({ path: '/health' }))).action).toBe('allow');
    }
  });

  it('validates options', () => {
    expect(() => createHttpRateLimiter({})).toThrow(/rules/);
    store = createMemoryStore({ clock });
    expect(() => createHttpRateLimiter({ limiter: fixed('v', 1), ipv6Subnet: 0 })).toThrow(
      /ipv6Subnet/,
    );
  });
});
