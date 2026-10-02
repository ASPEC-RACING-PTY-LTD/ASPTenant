import { createServer } from 'node:http';
import express from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { createOrgsAdminRouter, createOrgsMemberRouter } from '../src/adapters/express.js';
import { createOrgsAdminPlugin, createOrgsMemberPlugin } from '../src/adapters/fastify.js';
import { createOrgsAdminHandler, createOrgsMemberHandler } from '../src/adapters/fetch.js';
import { createOrgsAdminApp } from '../src/adapters/hono.js';
import { createOrgs } from '../src/service.js';
import { createMemoryOrgsStore } from '../src/stores/memory.js';

function makeService() {
  return createOrgs({ mode: 'multi', store: createMemoryOrgsStore() });
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('HTTP adapters', () => {
  it('express 5 admin create and member list', async () => {
    const orgs = makeService();
    const app = express();
    app.use(
      '/admin',
      createOrgsAdminRouter(orgs, {
        async resolveActor(req) {
          const id = req.headers['x-user-id'];
          return typeof id === 'string' ? { id } : null;
        },
      }),
    );
    app.use(
      '/member',
      createOrgsMemberRouter(orgs, {
        async resolveActor(req) {
          const id = req.headers['x-user-id'];
          return typeof id === 'string' ? { id } : null;
        },
      }),
    );
    const { url, close } = await listen(app);
    try {
      const created = await fetch(`${url}/admin/orgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
        body: JSON.stringify({ name: 'Express Org', slug: 'express-org' }),
      });
      expect(created.status).toBe(201);
      const org = (await created.json()) as { id: string };
      const mine = await fetch(`${url}/member/me/orgs`, {
        headers: { 'x-user-id': 'u1' },
      });
      expect(mine.status).toBe(200);
      const list = (await mine.json()) as unknown[];
      expect(list.length).toBe(1);
      expect(org.id).toBeTruthy();
    } finally {
      await close();
    }
  });

  it('express 4 admin create', async () => {
    const orgs = makeService();
    const app = express4();
    app.use(
      '/admin',
      createOrgsAdminRouter(orgs, {
        async resolveActor(req) {
          const id = req.headers['x-user-id'];
          return typeof id === 'string' ? { id } : null;
        },
      }),
    );
    const { url, close } = await listen(app as unknown as express.Express);
    try {
      const res = await fetch(`${url}/admin/orgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
        body: JSON.stringify({ name: 'E4', slug: 'e4-org' }),
      });
      expect(res.status).toBe(201);
    } finally {
      await close();
    }
  });

  it('fastify admin and member plugins', async () => {
    const orgs = makeService();
    const app = Fastify();
    await app.register(
      createOrgsAdminPlugin(orgs, {
        async resolveActor(req) {
          const id = req.headers['x-user-id'];
          return typeof id === 'string' ? { id } : null;
        },
      }),
      { prefix: '/admin' },
    );
    await app.register(
      createOrgsMemberPlugin(orgs, {
        async resolveActor(req) {
          const id = req.headers['x-user-id'];
          return typeof id === 'string' ? { id } : null;
        },
      }),
      { prefix: '/member' },
    );
    const created = await app.inject({
      method: 'POST',
      url: '/admin/orgs',
      headers: { 'x-user-id': 'u1', 'content-type': 'application/json' },
      payload: { name: 'Fast', slug: 'fast-org' },
    });
    expect(created.statusCode).toBe(201);
    const mine = await app.inject({
      method: 'GET',
      url: '/member/me/orgs',
      headers: { 'x-user-id': 'u1' },
    });
    expect(mine.statusCode).toBe(200);
    await app.close();
  });

  it('hono admin app', async () => {
    const orgs = makeService();
    const app = new Hono();
    app.route(
      '/admin',
      createOrgsAdminApp(orgs, {
        async resolveActor(c) {
          const id = c.req.header('x-user-id');
          return id ? { id } : null;
        },
      }),
    );
    const res = await app.request('/admin/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
      body: JSON.stringify({ name: 'Hono', slug: 'hono-org' }),
    });
    expect(res.status).toBe(201);
  });

  it('fetch handlers', async () => {
    const orgs = makeService();
    const admin = createOrgsAdminHandler(orgs, {
      basePath: '/admin',
      async resolveActor(req) {
        const id = req.headers.get('x-user-id');
        return id ? { id } : null;
      },
    });
    const member = createOrgsMemberHandler(orgs, {
      basePath: '/member',
      async resolveActor(req) {
        const id = req.headers.get('x-user-id');
        return id ? { id } : null;
      },
    });
    const created = await admin(
      new Request('http://local/admin/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
        body: JSON.stringify({ name: 'Fetch', slug: 'fetch-org' }),
      }),
    );
    expect(created.status).toBe(201);
    const mine = await member(
      new Request('http://local/member/me/orgs', { headers: { 'x-user-id': 'u1' } }),
    );
    expect(mine.status).toBe(200);
  });
});

// silence unused import warning for afterAll in some tooling
afterAll(() => {});
