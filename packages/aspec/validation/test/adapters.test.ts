import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateRequest as expressValidate } from '../src/adapters/express.js';
import { validateRequest as fastifyValidate } from '../src/adapters/fastify.js';
import { withValidation } from '../src/adapters/fetch.js';
import { validateRequest as honoValidate } from '../src/adapters/hono.js';
import { listen } from './helpers/http.js';

const bodySchema = z.object({ name: z.string().min(1) });
const querySchema = z.object({ q: z.string().min(1) });
const paramsSchema = z.object({ id: z.string().regex(/^\d+$/) });

const PROBLEM = 'application/problem+json';

describe.each([
  ['express 4', express4, '4.22.3'],
  ['express 5', express5, '5.2.1'],
])('%s middleware', (_label, express, version) => {
  let closer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closer?.();
    closer = undefined;
  });

  it(`validates body and params (${version})`, async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/items/:id',
      expressValidate({ body: bodySchema, params: paramsSchema }),
      (req, res) => {
        res.json(req.validated);
      },
    );
    const server = await listen(app as Parameters<typeof listen>[0]);
    closer = () => server.close();

    const ok = await fetch(`${server.url}/items/42`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Widget' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ body: { name: 'Widget' }, params: { id: '42' } });

    const bad = await fetch(`${server.url}/items/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain(PROBLEM);
    const problem = (await bad.json()) as { code: string; errors: { pointer: string }[] };
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors.some((e) => e.pointer.startsWith('/body'))).toBe(true);
    expect(problem.errors.some((e) => e.pointer.startsWith('/params'))).toBe(true);
  });
});

describe('fastify middleware', () => {
  it('validates and returns problem details', async () => {
    const app = Fastify();
    app.post(
      '/search',
      { preHandler: fastifyValidate({ body: bodySchema, query: querySchema }) },
      async (req) => req.validated,
    );
    const bad = await app.inject({
      method: 'POST',
      url: '/search?q=',
      headers: { 'content-type': 'application/json' },
      payload: { name: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain(PROBLEM);
    const problem = bad.json() as { errors: { pointer: string }[] };
    expect(problem.errors.length).toBeGreaterThan(0);

    const ok = await app.inject({
      method: 'POST',
      url: '/search?q=x',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'ok' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ body: { name: 'ok' }, query: { q: 'x' } });
    await app.close();
  });
});

describe('hono middleware', () => {
  it('validates body and headers', async () => {
    const app = new Hono();
    const headersSchema = z.object({ 'x-request-id': z.string().uuid() });
    app.post('/v1', honoValidate({ body: bodySchema, headers: headersSchema }), (c) =>
      c.json(c.get('validated')),
    );

    const bad = await app.request('/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'nope' },
      body: JSON.stringify({ name: 'A' }),
    });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain(PROBLEM);

    const ok = await app.request('/v1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': '123e4567-e89b-12d3-a456-426614174000',
      },
      body: JSON.stringify({ name: 'A' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('fetch adapter', () => {
  it('withValidation returns problem or calls handler', async () => {
    const handler = withValidation(
      { body: bodySchema, query: querySchema },
      async ({ validated }) => Response.json(validated),
    );
    const bad = await handler(
      new Request('http://local/x?q=', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain(PROBLEM);

    const ok = await handler(
      new Request('http://local/x?q=hi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Zed' }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ body: { name: 'Zed' }, query: { q: 'hi' } });
  });
});
