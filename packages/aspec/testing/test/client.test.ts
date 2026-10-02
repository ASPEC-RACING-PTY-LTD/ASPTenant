import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actAs,
  authHeader,
  cleanupAll,
  createSessionCookie,
  createTestClient,
  createTestJwtSigner,
} from '../src/index.js';

afterEach(async () => {
  await cleanupAll();
});

describe('createTestClient', () => {
  it('works with Express 5 on an ephemeral port', async () => {
    const app = express5();
    app.get('/ping', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.post('/echo', express5.json(), (req, res) => {
      res.status(201).json({ body: req.body });
    });
    const client = createTestClient(app);
    expect(client.kind).toBe('node');
    await client.get('/ping').expect(200).expectJson({ ok: true });
    await client
      .post('/echo')
      .send({ a: 1 })
      .expect(201)
      .expectJson({ body: { a: 1 } });
    await client.close();
  });

  it('works with Express 4', async () => {
    const app = express4();
    app.get('/v4', (_req, res) => {
      res.status(200).json({ v: 4 });
    });
    const client = createTestClient(app);
    await client.get('/v4').expect(200).expectJson({ v: 4 });
    await client.close();
  });

  it('works with Fastify inject', async () => {
    const app = Fastify();
    app.get('/fast', async () => ({ framework: 'fastify' }));
    await app.ready();
    const client = createTestClient(app);
    expect(client.kind).toBe('fastify');
    await client.get('/fast').expect(200).expectJson({ framework: 'fastify' });
  });

  it('works with Hono app.request', async () => {
    const app = new Hono();
    app.get('/hono', (c) => c.json({ framework: 'hono' }));
    const client = createTestClient(app);
    expect(client.kind).toBe('hono');
    await client.get('/hono').expect(200).expectJson({ framework: 'hono' });
  });

  it('works with a Fetch handler', async () => {
    const handler = (req: Request): Response => {
      const url = new URL(req.url);
      return Response.json({ path: url.pathname, q: url.searchParams.get('q') });
    };
    const client = createTestClient(handler);
    expect(client.kind).toBe('fetch');
    await client.get('/x').query({ q: '1' }).expect(200).expectJson({ path: '/x', q: '1' });
  });

  it('tracks cookies and supports actAs', async () => {
    const app = new Hono();
    app.get('/login', (c) => {
      c.header('set-cookie', 'sid=abc; Path=/; HttpOnly');
      return c.json({ ok: true });
    });
    app.get('/me', (c) => {
      const cookie = c.req.header('cookie') ?? '';
      const auth = c.req.header('authorization') ?? '';
      return c.json({ cookie, auth });
    });
    const client = createTestClient(app);
    await client.get('/login').expect(200).expectCookie('sid', 'abc');
    await client.get('/me').expectJson({ cookie: 'sid=abc', auth: '' });

    const signer = createTestJwtSigner({ secret: Buffer.alloc(32, 7) });
    const token = signer.signFor({ id: 'u1', roles: ['admin'] });
    const authed = actAs(client, { token });
    await authed.get('/me').expect((res) => {
      expect(res.json<{ auth: string }>().auth).toBe(`Bearer ${token}`);
    });

    const session = createSessionCookie({ name: 'session', value: 's1' });
    const cookied = actAs(client, { cookie: session });
    await cookied.get('/me').expect((res) => {
      expect(res.json<{ cookie: string }>().cookie).toContain('session=');
    });

    expect(authHeader(token).authorization).toBe(`Bearer ${token}`);
  });

  it('produces clear expectation diffs', async () => {
    const client = createTestClient(() => Response.json({ a: 1 }));
    await expect(client.get('/').expect(204)).rejects.toThrow(/Expected status 204/);
    await expect(client.get('/').expectJson({ a: 2 })).rejects.toThrow(/Expected JSON body/);
  });
});
