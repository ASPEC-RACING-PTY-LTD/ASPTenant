import type { AddressInfo } from 'node:net';
import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ExpressRateLimitRequest,
  rateLimit as expressRateLimit,
} from '../src/adapters/express.js';
import { fastifyRateLimit } from '../src/adapters/fastify.js';
import { createFetchRateLimiter, withRateLimit } from '../src/adapters/fetch.js';
import { rateLimit as honoRateLimit, type RateLimitVariables } from '../src/adapters/hono.js';
import { keys } from '../src/http.js';
import { createRateLimiter } from '../src/limiter.js';
import { createMemoryStore, type MemoryRateLimitStore } from '../src/stores/memory.js';

let store: MemoryRateLimitStore;
afterEach(async () => {
  await store?.close();
});

function limiter(name = 'default', limit = 2) {
  store = createMemoryStore();
  return createRateLimiter({
    store,
    policy: { name, algorithm: 'fixed-window', limit, windowMs: 60_000 },
  });
}

async function expectRejected(res: Response, policy: string) {
  expect(res.status).toBe(429);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(res.headers.get('ratelimit')).toMatch(new RegExp(`^"${policy}";r=0;t=\\d+$`));
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ status: 429, title: 'Too Many Requests', policy });
  expect(typeof body.retryAfter).toBe('number');
}

describe.each([
  { name: 'Express 5', create: () => express5() },
  { name: 'Express 4', create: () => express4() },
])('$name adapter', ({ create }) => {
  it('limits requests, sets headers and exposes req.rateLimit', async () => {
    const app = create();
    app.use(expressRateLimit({ limiter: limiter('web') }));
    app.get('/', (req, res) => {
      const outcome = (req as ExpressRateLimitRequest).rateLimit;
      res.json({ remaining: outcome?.decision?.remaining });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const first = await fetch(base);
      expect(first.status).toBe(200);
      expect(first.headers.get('ratelimit-policy')).toBe('"web";q=2;w=60');
      expect(first.headers.get('ratelimit')).toMatch(/^"web";r=1;t=\d+$/);
      expect(await first.json()).toEqual({ remaining: 1 });
      await fetch(base);
      await expectRejected(await fetch(base), 'web');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes key generator errors to next()', async () => {
    const app = create();
    const broken = limiter('b');
    app.use(
      expressRateLimit({
        limiter: broken,
        key: () => {
          throw new Error('key generator failed');
        },
      }),
    );
    app.get('/', (_req, res) => {
      res.send('ok');
    });
    app.use(
      (
        err: Error,
        _req: unknown,
        res: { status(n: number): { send(b: string): void } },
        _next: unknown,
      ) => {
        res.status(500).send(err.message);
      },
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('key generator failed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Fastify adapter', () => {
  it('applies global rules and per-route overrides', async () => {
    const app = Fastify();
    const globalLimiter = limiter('global', 2);
    const strict = createRateLimiter({
      store,
      policy: { name: 'strict', algorithm: 'fixed-window', limit: 1, windowMs: 60_000 },
    });
    await app.register(fastifyRateLimit, { limiter: globalLimiter });
    app.get('/', async (request) => ({ remaining: request.rateLimit?.decision?.remaining }));
    app.get('/health', { config: { rateLimit: false } }, async () => 'ok');
    app.post(
      '/login',
      { config: { rateLimit: { limiter: strict, key: keys.ip() } } },
      async () => 'ok',
    );

    const first = await app.inject({ method: 'GET', url: '/' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['ratelimit-policy']).toBe('"global";q=2;w=60');
    expect(first.json()).toEqual({ remaining: 1 });
    await app.inject({ method: 'GET', url: '/' });
    const limited = await app.inject({ method: 'GET', url: '/' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toMatchObject({ status: 429, policy: 'global' });

    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/login' })).statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/login' });
    expect(login.statusCode).toBe(429);
    expect(login.json()).toMatchObject({ policy: 'strict' });
    await app.close();
  });

  it('only limits configured routes when global is false', async () => {
    const app = Fastify();
    const l = limiter('opt-in', 1);
    await app.register(fastifyRateLimit, { global: false, trustProxy: 'loopback' });
    app.get('/free', async () => 'ok');
    app.get('/limited', { config: { rateLimit: { limiter: l } } }, async () => 'ok');
    for (let i = 0; i < 3; i++) expect((await app.inject('/free')).statusCode).toBe(200);
    const h = { 'x-forwarded-for': '203.0.113.1' };
    expect((await app.inject({ url: '/limited', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ url: '/limited', headers: h })).statusCode).toBe(429);
    const other = { 'x-forwarded-for': '203.0.113.2' };
    expect((await app.inject({ url: '/limited', headers: other })).statusCode).toBe(200);
    await app.close();
  });
});

describe('Hono adapter', () => {
  it('limits requests using the provided remote address', async () => {
    const app = new Hono<{ Variables: RateLimitVariables }>();
    app.use(
      '*',
      honoRateLimit({
        limiter: limiter('hono'),
        getRemoteAddress: (c) => c.req.header('x-test-ip'),
      }),
    );
    app.get('/', (c) => c.json({ remaining: c.get('rateLimit').decision?.remaining }));
    const a = { 'x-test-ip': '192.0.2.1' };
    const first = await app.request('/', { headers: a });
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit')).toMatch(/^"hono";r=1;t=\d+$/);
    expect(await first.json()).toEqual({ remaining: 1 });
    await app.request('/', { headers: a });
    await expectRejected(await app.request('/', { headers: a }), 'hono');
    expect((await app.request('/', { headers: { 'x-test-ip': '192.0.2.2' } })).status).toBe(200);
  });
});

describe('Fetch adapter', () => {
  it('wraps a handler and adds headers', async () => {
    const handler = withRateLimit(
      async () => new Response('hello', { headers: { 'x-app': '1' } }),
      {
        limiter: limiter('fetch'),
        getRemoteAddress: () => '198.51.100.7',
      },
    );
    const first = await handler(new Request('http://localhost/items'));
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('hello');
    expect(first.headers.get('x-app')).toBe('1');
    expect(first.headers.get('ratelimit-policy')).toBe('"fetch";q=2;w=60');
    await handler(new Request('http://localhost/items'));
    await expectRejected(await handler(new Request('http://localhost/items')), 'fetch');
  });

  it('exposes check, rejection and applyHeaders for custom flows', async () => {
    const rl = createFetchRateLimiter({
      limiter: limiter('manual', 1),
      key: keys.apiKey(),
    });
    const req = () => new Request('http://localhost/', { headers: { 'x-api-key': 'k1' } });
    const ok = await rl.check(req());
    expect(ok.action).toBe('allow');
    const res = rl.applyHeaders(new Response('x'), ok);
    expect(res.headers.get('ratelimit')).toMatch(/^"manual";r=0;t=\d+$/);
    const denied = await rl.check(req());
    await expectRejected(rl.rejection(denied), 'manual');
    // Requests without an API key skip the rule entirely.
    expect((await rl.check(new Request('http://localhost/'))).results).toEqual([]);
  });
});
