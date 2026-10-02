import type { AddressInfo } from 'node:net';
import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  httpInstrumentation as expressHttp,
  observabilityEndpoints,
} from '../src/adapters/express.js';
import { fastifyObservability } from '../src/adapters/fastify.js';
import { withObservability } from '../src/adapters/fetch.js';
import { observability as honoObservability } from '../src/adapters/hono.js';
import { createHealth } from '../src/health.js';
import { createMetricsRegistry } from '../src/metrics.js';

const servers: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe.each([
  { name: 'Express 5', create: () => express5() },
  { name: 'Express 4', create: () => express4() },
])('$name HTTP metrics', ({ create }) => {
  it('records route templates and serves health endpoints', async () => {
    const registry = createMetricsRegistry();
    const health = createHealth({ checks: { ok: async () => ({ ok: true }) } });
    const app = create();
    app.use(observabilityEndpoints({ health, registry }));
    app.use(
      expressHttp({
        registry,
        ignorePaths: ['/livez', '/readyz', '/healthz', '/metrics'],
      }),
    );
    app.get('/users/:id', (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    servers.push({
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/users/42`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('http_server_request_duration_seconds');
    expect(metrics).toContain('/users/:id');
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });
});

describe('Fastify adapter', () => {
  it('records route templates', async () => {
    const registry = createMetricsRegistry();
    const app = Fastify();
    await app.register(fastifyObservability, {
      registry,
      endpoints: { health: createHealth({ checks: { ok: async () => ({ ok: true }) } }), registry },
    });
    app.get('/items/:id', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/items/1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('/items/:id');
    await app.close();
  });
});

describe('Hono adapter', () => {
  it('records route templates', async () => {
    const registry = createMetricsRegistry();
    const app = new Hono();
    app.use(
      '*',
      honoObservability({
        registry,
        endpoints: {
          health: createHealth({ checks: { ok: async () => ({ ok: true }) } }),
          registry,
        },
      }),
    );
    app.get('/posts/:id', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/posts/9');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const metrics = await (await app.request('http://localhost/metrics')).text();
    expect(metrics).toContain('/posts/:id');
  });
});

describe('Fetch adapter', () => {
  it('wraps handlers with metrics and endpoints', async () => {
    const registry = createMetricsRegistry();
    const handler = withObservability(async () => Response.json({ ok: true }), {
      registry,
      getRoute: () => '/api',
      endpoints: { health: createHealth({ checks: { ok: async () => ({ ok: true }) } }), registry },
    });
    const res = await handler(new Request('http://localhost/api'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const metrics = await handler(new Request('http://localhost/metrics'));
    expect(await metrics.text()).toContain('http_server_request_duration_seconds');
  });
});
