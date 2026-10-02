import { createServer } from 'node:http';
import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiKeyMiddleware, createApiKeysAdminRouter } from '../src/adapters/express.js';
import { apiKeysAdminPlugin, createApiKeyPreHandler } from '../src/adapters/fastify.js';
import { createApiKeysAdminHandler, withApiKeyAuth } from '../src/adapters/fetch.js';
import { apiKeyMiddleware, createApiKeysAdminApp } from '../src/adapters/hono.js';
import { createApiKeys } from '../src/service.js';
import { createMemoryStore } from '../src/stores/memory.js';

const PEPPER = Buffer.alloc(32, 5);

function setup() {
  const api = createApiKeys({
    store: createMemoryStore(),
    pepper: PEPPER,
    nodeEnv: 'test',
    usageFlushIntervalMs: 0,
    verificationFailureSampleRate: 0,
  });
  return api;
}

async function listen(app: express5.Express): Promise<{ url: string; close: () => Promise<void> }> {
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

describe('adapters', () => {
  const apis: ReturnType<typeof setup>[] = [];
  afterEach(async () => {
    while (apis.length) await apis.pop()!.shutdown();
  });

  it('Express 5 verifies bearer keys', async () => {
    const api = setup();
    apis.push(api);
    const created = await api.create({
      name: 'e5',
      scopes: ['read:x'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const app = express5();
    app.get('/me', createApiKeyMiddleware(api), (req, res) => {
      res.json({ id: req.apiKey?.keyId });
    });
    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/me`, {
        headers: { Authorization: `Bearer ${created.secret}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: created.key.id });
      const denied = await fetch(`${url}/me`);
      expect(denied.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('Express 4 verifies X-API-Key and serves admin', async () => {
    const api = setup();
    apis.push(api);
    const created = await api.create({
      name: 'e4',
      scopes: ['read:x'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const app = express4();
    app.get(
      '/me',
      createApiKeyMiddleware(api),
      (req: { apiKey?: { keyId: string } }, res: { json: (b: unknown) => void }) => {
        res.json({ id: req.apiKey?.keyId });
      },
    );
    app.use(
      '/admin',
      createApiKeysAdminRouter(api, {
        resolveActor: () => ({ id: 'admin', type: 'user' }),
        authorize: async () => true,
      }),
    );
    const { url, close } = await listen(app as unknown as express5.Express);
    try {
      const res = await fetch(`${url}/me`, { headers: { 'X-API-Key': created.secret } });
      expect(res.status).toBe(200);
      const listed = await fetch(`${url}/admin/keys`);
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { items: unknown[] };
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
    }
  });

  it('Fastify preHandler and admin plugin', async () => {
    const api = setup();
    apis.push(api);
    const created = await api.create({
      name: 'ff',
      scopes: ['read:x'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const app = Fastify();
    app.get('/me', { preHandler: createApiKeyPreHandler(api) }, async (req) => ({
      id: req.apiKey?.keyId,
    }));
    await app.register(
      async (instance) => {
        await instance.register(apiKeysAdminPlugin, {
          api,
          resolveActor: () => ({ id: 'admin' }),
          authorize: async () => true,
        });
      },
      { prefix: '/admin' },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(res.statusCode).toBe(200);
    const admin = await app.inject({ method: 'GET', url: '/admin/keys' });
    expect(admin.statusCode).toBe(200);
    await app.close();
  });

  it('Hono middleware and admin app', async () => {
    const api = setup();
    apis.push(api);
    const created = await api.create({
      name: 'hono',
      scopes: ['read:x'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const app = new Hono<{ Variables: { apiKey: { keyId: string } } }>();
    app.use('/me', apiKeyMiddleware(api));
    app.get('/me', (c) => c.json({ id: c.get('apiKey').keyId }));
    const adminApp = createApiKeysAdminApp(api, {
      resolveActor: () => ({ id: 'admin' }),
      authorize: async () => true,
    });
    app.route('/admin', adminApp);
    const res = await app.request('/me', {
      headers: { Authorization: `Bearer ${created.secret}` },
    });
    expect(res.status).toBe(200);
    // Admin app matches on its own path space.
    const admin = await adminApp.request('/keys');
    expect(admin.status).toBe(200);
  });

  it('Fetch wrapper and admin handler', async () => {
    const api = setup();
    apis.push(api);
    const created = await api.create({
      name: 'fetch',
      scopes: ['read:x'],
      ownerType: 'user',
      ownerId: 'u1',
    });
    const handler = withApiKeyAuth(async (_req, principal) => {
      return Response.json({ id: principal.keyId });
    }, api);
    const ok = await handler(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${created.secret}` },
      }),
    );
    expect(ok.status).toBe(200);
    const admin = createApiKeysAdminHandler(api, {
      resolveActor: () => ({ id: 'admin' }),
      authorize: async () => true,
      basePath: '',
    });
    const listed = await admin(new Request('http://localhost/keys'));
    expect(listed.status).toBe(200);
  });
});
