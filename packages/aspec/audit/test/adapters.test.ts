import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
// Express 4 is installed as the `express4` package alias (npm:express@^4.22.3).
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { auditAdminRouter, auditContext as expressContext } from '../src/adapters/express.js';
import { auditAdminPlugin, registerAuditContext } from '../src/adapters/fastify.js';
import { createAuditAdminFetchHandler, withAuditContext } from '../src/adapters/fetch.js';
import { createAuditAdminApp, auditContext as honoContext } from '../src/adapters/hono.js';
import { createAuditLogger } from '../src/logger.js';
import { createMemoryAuditStore } from '../src/stores/memory.js';

type Express4 = typeof express;

async function listen(app: {
  listen: (port: number, host: string, cb: () => void) => Server;
}): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('framework adapters', () => {
  it('express 5 correlation and admin router', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const app = express();
    app.use(
      expressContext({
        resolveActor: () => ({ id: 'e5', type: 'user' }),
        trustProxy: false,
      }),
    );
    app.get('/work', async (_req, res) => {
      await audit.record({ action: 'app.work.done' });
      res.json({ ok: true });
    });
    app.use(
      '/admin/audit',
      auditAdminRouter(audit, {
        authorize: async ({ action }) => action === 'audit.read' || action === 'audit.verify',
      }),
    );
    const { base, close } = await listen(app);
    try {
      const work = await fetch(`${base}/work`, {
        headers: { 'x-request-id': 'req-express-5', 'user-agent': 'express5-test' },
      });
      expect(work.status).toBe(200);
      expect(work.headers.get('x-request-id')).toBe('req-express-5');
      const events = await audit.query({});
      expect(events.events[0]?.requestId).toBe('req-express-5');
      expect(events.events[0]?.actor?.id).toBe('e5');
      const admin = await fetch(`${base}/admin/audit/events`);
      expect(admin.status).toBe(200);
      const body = (await admin.json()) as { events: unknown[] };
      expect(body.events.length).toBeGreaterThan(0);
    } finally {
      await close();
      await audit.close();
    }
  });

  it('express 4 correlation middleware', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const app = (express4 as unknown as Express4)();
    app.use(expressContext({ resolveActor: () => ({ id: 'e4' }) }));
    app.get('/work', async (_req, res) => {
      await audit.record({ action: 'app.work.done' });
      res.json({ ok: true });
    });
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/work`, { headers: { 'x-request-id': 'req-e4' } });
      expect(res.status).toBe(200);
      expect((await audit.query({})).events[0]?.requestId).toBe('req-e4');
      expect((await audit.query({})).events[0]?.actor?.id).toBe('e4');
    } finally {
      await close();
      await audit.close();
    }
  });

  it('fastify correlation and admin plugin', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const app = Fastify();
    registerAuditContext(app, { resolveActor: () => ({ id: 'ff' }) });
    app.get('/work', async () => {
      await audit.record({ action: 'app.work.done' });
      return { ok: true };
    });
    await app.register(auditAdminPlugin, {
      prefix: '/admin/audit',
      audit,
      authorize: async () => true,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${base}/work`, { headers: { 'x-request-id': 'req-ff' } });
      expect(res.status).toBe(200);
      expect((await audit.query({})).events[0]?.requestId).toBe('req-ff');
      const admin = await fetch(`${base}/admin/audit/events`);
      expect(admin.status).toBe(200);
    } finally {
      await app.close();
      await audit.close();
    }
  });

  it('hono correlation and admin app', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const app = new Hono();
    app.use('*', honoContext({ resolveActor: () => ({ id: 'hono' }) }));
    app.get('/work', async (c) => {
      await audit.record({ action: 'app.work.done' });
      return c.json({ ok: true });
    });
    app.route('/admin/audit', createAuditAdminApp(audit, { authorize: async () => true }));
    const res = await app.request('/work', {
      headers: { 'x-request-id': 'req-hono', 'user-agent': 'hono-test' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-hono');
    expect((await audit.query({})).events[0]?.actor?.id).toBe('hono');
    const admin = await app.request('/admin/audit/events');
    expect(admin.status).toBe(200);
    await audit.close();
  });

  it('fetch handler correlation and admin', async () => {
    const store = createMemoryAuditStore();
    const audit = createAuditLogger({ sink: store });
    const work = withAuditContext(
      async () => {
        await audit.record({ action: 'app.work.done' });
        return Response.json({ ok: true });
      },
      { resolveActor: () => ({ id: 'fetch' }) },
    );
    const admin = createAuditAdminFetchHandler(audit, {
      basePath: '/admin/audit',
      authorize: async () => true,
    });
    const res = await work(
      new Request('http://localhost/work', { headers: { 'x-request-id': 'req-fetch' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-fetch');
    expect((await audit.query({})).events[0]?.actor?.id).toBe('fetch');
    const adminRes = await admin(new Request('http://localhost/admin/audit/events'));
    expect(adminRes.status).toBe(200);
    await audit.close();
  });
});
