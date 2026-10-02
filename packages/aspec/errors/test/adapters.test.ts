import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { asyncHandler, createExpressErrorHandling } from '../src/adapters/express.js';
import { fastifyErrorHandling, registerErrorHandling } from '../src/adapters/fastify.js';
import { fetchNotFound, withErrorHandling } from '../src/adapters/fetch.js';
import { createHonoErrorHandling } from '../src/adapters/hono.js';
import { ConflictError, createErrorHandler, InternalError, NotFoundError } from '../src/index.js';
import { listen, memoryLogger, type TestServer } from './helpers/http.js';

const PROBLEM = 'application/problem+json; charset=utf-8';

describe.each([
  ['express 4', express4, '4.22.3'],
  ['express 5', express5, '5.2.1'],
])('%s', (_label, express, version) => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function build(opts: { async?: 'native' | 'wrapped' } = {}) {
    const { logger, entries } = memoryLogger();
    const errors = createExpressErrorHandling({
      logger,
      typeBaseUri: 'https://errors.example.com/',
    });
    const app = express();
    app.use(errors.requestContext);
    app.use(express.json({ limit: '1kb' }));
    app.get('/sync', () => {
      throw new ConflictError('Name taken', { details: { field: 'name' } });
    });
    app.get('/internal', () => {
      throw new InternalError('db password=hunter2 rejected');
    });
    app.get('/context', (_req, res) => {
      res.json({ id: errors.handler.correlation.getId(), local: res.locals.correlationId });
    });
    const asyncRoute = async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new NotFoundError('Order 7 not found');
    };
    if (opts.async === 'native') app.get('/async', asyncRoute);
    else app.get('/async', asyncHandler(asyncRoute));
    app.post('/echo', (req, res) => {
      res.json(req.body);
    });
    app.use(errors.notFound);
    app.use(errors.errorHandler);
    return { app, entries };
  }

  it(`maps thrown errors to problem responses (express ${version})`, async () => {
    const { app, entries } = build();
    server = await listen(app);
    const res = await fetch(`${server.url}/sync`, { headers: { 'x-request-id': 'client-id-1' } });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe(PROBLEM);
    expect(res.headers.get('x-request-id')).toBe('client-id-1');
    expect(await res.json()).toEqual({
      type: 'https://errors.example.com/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Name taken',
      instance: '/sync',
      code: 'CONFLICT',
      correlationId: 'client-id-1',
      details: { field: 'name' },
    });
    expect(entries[0]?.level).toBe('info');
  });

  it('hides internal errors and logs them at error level', async () => {
    const { app, entries } = build();
    server = await listen(app);
    const res = await fetch(`${server.url}/internal`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(entries[0]?.level).toBe('error');
    expect(JSON.stringify(entries[0])).not.toContain('hunter2');
  });

  it('propagates the correlation ID through AsyncLocalStorage', async () => {
    const { app } = build();
    server = await listen(app);
    const res = await fetch(`${server.url}/context`, { headers: { 'x-request-id': 'bad id!' } });
    const body = (await res.json()) as { id: string; local: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.local).toBe(body.id);
    expect(res.headers.get('x-request-id')).toBe(body.id);
  });

  it('handles async errors', async () => {
    const { app } = build({ async: version.startsWith('5') ? 'native' : 'wrapped' });
    server = await listen(app);
    const res = await fetch(`${server.url}/async`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Order 7 not found');
  });

  it('maps body parser JSON syntax and size errors', async () => {
    const { app } = build();
    server = await listen(app);
    const bad = await fetch(`${server.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a": 1,',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      code: 'INVALID_JSON',
      detail: 'Request body is not valid JSON',
    });
    const big = await fetch(`${server.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('answers unmatched routes with 404 problem details', async () => {
    const { app } = build();
    server = await listen(app);
    const res = await fetch(`${server.url}/nope?token=secret`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
    expect(body.instance).toBe('/nope');
  });
});

describe('fastify', () => {
  it('registers error, not-found and correlation handling', async () => {
    const { logger, entries } = memoryLogger();
    const app = Fastify();
    const errors = registerErrorHandling(app, { logger });
    app.get('/conflict', async () => {
      throw new ConflictError('Duplicate');
    });
    app.get('/crash', async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('undefined is not a function in secret module');
    });
    app.get('/context', async (request) => ({
      als: errors.handler.correlation.getId(),
      assigned: errors.correlationId(request),
    }));
    app.post('/json', async (request) => request.body);

    const conflict = await app.inject({
      method: 'GET',
      url: '/conflict',
      headers: { 'x-request-id': 'fid-1' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.headers['content-type']).toBe(PROBLEM);
    expect(conflict.headers['x-request-id']).toBe('fid-1');
    expect(conflict.json()).toMatchObject({
      code: 'CONFLICT',
      detail: 'Duplicate',
      correlationId: 'fid-1',
    });

    const crash = await app.inject({ method: 'GET', url: '/crash' });
    expect(crash.statusCode).toBe(500);
    expect(crash.body).not.toContain('secret module');
    expect(entries.some((e) => e.level === 'error')).toBe(true);

    const ctx = await app.inject({
      method: 'GET',
      url: '/context',
      headers: { 'x-request-id': 'fid-2' },
    });
    expect(ctx.json()).toEqual({ als: 'fid-2', assigned: 'fid-2' });

    const missing = await app.inject({ method: 'GET', url: '/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', instance: '/missing' });

    const badJson = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ code: 'INVALID_JSON' });
    await app.close();
  });

  it('works as a plugin that skips encapsulation', async () => {
    const app = Fastify();
    await app.register(fastifyErrorHandling, { format: 'envelope' });
    app.get('/x', async () => {
      throw new NotFoundError('No x');
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'No x' } });
    await app.close();
  });
});

describe('hono', () => {
  it('handles errors, not found and correlation', async () => {
    const errors = createHonoErrorHandling({ typeBaseUri: 'https://errors.example.com/' });
    const app = new Hono();
    app.use('*', errors.middleware);
    app.onError(errors.onError);
    app.notFound(errors.notFound);
    app.get('/conflict', () => {
      throw new ConflictError('Duplicate');
    });
    app.get('/async', async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new InternalError('leaky internal message');
    });
    app.get('/context', (c) =>
      c.json({ id: errors.handler.correlation.getId(), assigned: errors.correlationId(c) }),
    );

    const conflict = await app.request('/conflict', { headers: { 'x-request-id': 'h-1' } });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type')).toBe(PROBLEM);
    expect(conflict.headers.get('x-request-id')).toBe('h-1');
    expect(await conflict.json()).toMatchObject({
      type: 'https://errors.example.com/conflict',
      correlationId: 'h-1',
    });

    const internal = await app.request('/async');
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain('leaky');

    const ctx = await app.request('/context', { headers: { 'x-request-id': 'h-2' } });
    expect(await ctx.json()).toEqual({ id: 'h-2', assigned: 'h-2' });
    expect(ctx.headers.get('x-request-id')).toBe('h-2');

    const missing = await app.request('/nothing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND', instance: '/nothing' });
  });
});

describe('fetch', () => {
  it('wraps a fetch handler with safe error responses and correlation', async () => {
    const handler = createErrorHandler({ format: 'problem' });
    const app = withErrorHandling(
      async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/ok') return Response.json({ id: handler.correlation.getId() });
        if (url.pathname === '/immutable') return fetchLikeResponse();
        await new Promise((r) => setTimeout(r, 1));
        throw new ConflictError('Nope');
      },
      { handler },
    );
    const ok = await app(new Request('http://local/ok', { headers: { 'x-request-id': 'f-1' } }));
    expect(await ok.json()).toEqual({ id: 'f-1' });
    expect(ok.headers.get('x-request-id')).toBe('f-1');
    const failed = await app(new Request('http://local/fail'));
    expect(failed.status).toBe(409);
    expect(failed.headers.get('content-type')).toBe(PROBLEM);
    expect(failed.headers.get('x-request-id')).toBeTruthy();
    expect(await failed.json()).toMatchObject({ code: 'CONFLICT', instance: '/fail' });
    const immutable = await app(new Request('http://local/immutable'));
    expect(immutable.headers.get('x-request-id')).toBeTruthy();
    expect(await immutable.text()).toBe('body');

    const notFound = fetchNotFound();
    const nf = notFound(new Request('http://local/zzz'));
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

function fetchLikeResponse(): Response {
  const res = new Response('body');
  Object.defineProperty(res, 'headers', {
    value: new Proxy(res.headers, {
      get(target, prop) {
        if (prop === 'set') {
          return () => {
            throw new TypeError('immutable');
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
  });
  return res;
}
