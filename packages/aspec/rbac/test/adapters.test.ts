import express from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createRbacAdminRouter, createRbacMiddleware } from '../src/adapters/express.js';
import { createRbacAdminPlugin, createRbacHooks } from '../src/adapters/fastify.js';
import { createRbacAdminFetchHandler, createRbacFetchGuards } from '../src/adapters/fetch.js';
import {
  createRbacMiddleware as createHonoMiddleware,
  createRbacAdminApp,
} from '../src/adapters/hono.js';
import { createRbac, defineRbac } from '../src/index.js';
import { createMemoryStore } from '../src/memory.js';
import type { Subject } from '../src/ports.js';

const definition = defineRbac({
  permissions: ['posts:read', 'posts:write'],
  roles: [
    { key: 'viewer', permissions: ['posts:read'] },
    { key: 'admin', permissions: ['rbac:admin', 'posts:read', 'posts:write'] },
  ],
});

function makeRbac() {
  return createRbac({ store: createMemoryStore(), definition, preventEscalation: false });
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('HTTP adapters', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) {
      const c = closers.pop();
      if (c) await c();
    }
  });

  it('guards Express 5 routes and serves admin API', async () => {
    const rbac = makeRbac();
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    await rbac.admin.assignRole({ subjectId: 'admin', roleKey: 'admin' });
    const mw = createRbacMiddleware(rbac);
    const getSubject = (req: express.Request): Subject | null => {
      const id = req.header('x-user');
      return id ? { id } : null;
    };
    const app = express();
    app.get('/posts', mw.requirePermission('posts:read', { getSubject }), (_req, res) => {
      res.json({ ok: true });
    });
    app.use('/admin/rbac', createRbacAdminRouter(rbac, { getSubject }));
    const { url, close } = await listen(app);
    closers.push(close);

    const denied = await fetch(`${url}/posts`);
    expect(denied.status).toBe(401);

    const forbidden = await fetch(`${url}/posts`, { headers: { 'x-user': 'nobody' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('content-type')).toContain('application/problem+json');

    const ok = await fetch(`${url}/posts`, { headers: { 'x-user': 'u1' } });
    expect(ok.status).toBe(200);

    const roles = await fetch(`${url}/admin/rbac/roles`, { headers: { 'x-user': 'admin' } });
    expect(roles.status).toBe(200);
    const body = (await roles.json()) as unknown[];
    expect(body.length).toBeGreaterThan(0);
  });

  it('guards Express 4 routes', async () => {
    const rbac = makeRbac();
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    const mw = createRbacMiddleware(rbac);
    const getSubject = (req: express.Request): Subject | null => {
      const id = req.header('x-user');
      return id ? { id } : null;
    };
    const app = express4();
    app.get('/posts', mw.requirePermission('posts:read', { getSubject }), (_req, res) => {
      res.json({ ok: true });
    });
    const { url, close } = await listen(app as unknown as express.Express);
    closers.push(close);
    const ok = await fetch(`${url}/posts`, { headers: { 'x-user': 'u1' } });
    expect(ok.status).toBe(200);
  });

  it('guards Fastify routes and admin plugin', async () => {
    const rbac = makeRbac();
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    await rbac.admin.assignRole({ subjectId: 'admin', roleKey: 'admin' });
    const hooks = createRbacHooks(rbac);
    const getSubject = (req: { headers: Record<string, unknown> }): Subject | null => {
      const id = req.headers['x-user'];
      return typeof id === 'string' ? { id } : null;
    };
    const app = Fastify();
    app.get(
      '/posts',
      { preHandler: hooks.requirePermission('posts:read', { getSubject }) },
      async () => ({ ok: true }),
    );
    await app.register(createRbacAdminPlugin(rbac, { getSubject }), { prefix: '/admin/rbac' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(async () => {
      await app.close();
    });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${addr.port}`;
    const ok = await app.inject({ method: 'GET', url: '/posts', headers: { 'x-user': 'u1' } });
    expect(ok.statusCode).toBe(200);
    const roles = await fetch(`${url}/admin/rbac/roles`, { headers: { 'x-user': 'admin' } });
    expect(roles.status).toBe(200);
  });

  it('guards Hono routes and admin app', async () => {
    const rbac = makeRbac();
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    await rbac.admin.assignRole({ subjectId: 'admin', roleKey: 'admin' });
    const mw = createHonoMiddleware(rbac);
    const getSubject = (c: {
      req: { header: (n: string) => string | undefined };
    }): Subject | null => {
      const id = c.req.header('x-user');
      return id ? { id } : null;
    };
    const app = new Hono();
    app.get('/posts', mw.requirePermission('posts:read', { getSubject }), (c) =>
      c.json({ ok: true }),
    );
    app.route('/admin/rbac', createRbacAdminApp(rbac, { getSubject }));
    const ok = await app.request('/posts', { headers: { 'x-user': 'u1' } });
    expect(ok.status).toBe(200);
    const roles = await app.request('/admin/rbac/roles', { headers: { 'x-user': 'admin' } });
    expect(roles.status).toBe(200);
  });

  it('guards Fetch handlers and admin fetch handler', async () => {
    const rbac = makeRbac();
    await rbac.admin.assignRole({ subjectId: 'u1', roleKey: 'viewer' });
    await rbac.admin.assignRole({ subjectId: 'admin', roleKey: 'admin' });
    const guards = createRbacFetchGuards(rbac);
    const getSubject = (req: Request): Subject | null => {
      const id = req.headers.get('x-user');
      return id ? { id } : null;
    };
    const handler = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === '/posts') {
        const g = await guards.requirePermission('posts:read', req, { getSubject });
        if (g.response) return g.response;
        return Response.json({ ok: true });
      }
      return createRbacAdminFetchHandler(rbac, { getSubject, basePath: '/admin/rbac' })(req);
    };
    const ok = await handler(new Request('http://local/posts', { headers: { 'x-user': 'u1' } }));
    expect(ok.status).toBe(200);
    const roles = await handler(
      new Request('http://local/admin/rbac/roles', { headers: { 'x-user': 'admin' } }),
    );
    expect(roles.status).toBe(200);
  });
});
