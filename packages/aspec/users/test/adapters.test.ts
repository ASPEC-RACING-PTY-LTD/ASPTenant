import type { AddressInfo } from 'node:net';
import express from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUsersAdminRouter, createUsersSelfServiceRouter } from '../src/adapters/express.js';
import { createUsersAdminPlugin, createUsersSelfServicePlugin } from '../src/adapters/fastify.js';
import { createUsersAdminHandler, createUsersSelfServiceHandler } from '../src/adapters/fetch.js';
import { createUsersAdminApp, createUsersSelfServiceApp } from '../src/adapters/hono.js';
import type { Subject } from '../src/ports.js';
import { createUsers, USERS_PERMISSIONS, type UsersService } from '../src/service.js';
import { createMemoryUsersStore } from '../src/stores/memory.js';
import { FakeAudit, FakeClock, FakePermissions } from './helpers/fakes.js';

interface Res {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted dynamically in tests.
  body: any;
  headers: Headers;
}
type Send = (
  method: string,
  path: string,
  init?: { body?: unknown; raw?: string; headers?: Record<string, string> },
) => Promise<Res>;

interface Harness {
  send: Send;
  close(): Promise<void>;
}

const actorFromHeader = (value: string | undefined | null): Subject | null =>
  value ? { id: value, type: 'user' } : null;

function buildService(): { users: UsersService; audit: FakeAudit } {
  const audit = new FakeAudit();
  const users = createUsers({
    store: createMemoryUsersStore(),
    clock: new FakeClock(),
    audit,
    permissions: new FakePermissions({ admin: USERS_PERMISSIONS, reader: ['users:read'] }),
    preferences: { theme: { type: 'string', enum: ['light', 'dark'], default: 'light' } },
  });
  return { users, audit };
}

async function toRes(r: Response): Promise<Res> {
  const text = await r.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
}

function initFor(init: Parameters<Send>[2] = {}, method = 'GET'): RequestInit {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.body !== undefined) body = JSON.stringify(init.body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return { method, headers, ...(body === undefined ? {} : { body }) };
}

async function expressHarness(
  lib: typeof express,
  users: UsersService,
  withJsonParser: boolean,
): Promise<Harness> {
  const app = lib();
  if (withJsonParser) app.use(lib.json());
  const resolveActor = (req: express.Request) => actorFromHeader(req.get('x-user-id'));
  app.use('/admin', createUsersAdminRouter(users, { resolveActor, bodyLimit: 2048 }));
  app.use('/account', createUsersSelfServiceRouter(users, { resolveActor, bodyLimit: 2048 }));
  app.use((_req, res) => {
    res.status(404).json({ fallthrough: true });
  });
  app.use(
    (
      err: { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ appError: true });
    },
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    send: async (method, path, init) => toRes(await fetch(`${base}${path}`, initFor(init, method))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function fastifyHarness(users: UsersService): Promise<Harness> {
  const app = Fastify({ bodyLimit: 2048 });
  const resolveActor = (req: { headers: Record<string, string | string[] | undefined> }) =>
    actorFromHeader(req.headers['x-user-id'] as string | undefined);
  await app.register(createUsersAdminPlugin(users, { resolveActor, bodyLimit: 2048 }), {
    prefix: '/admin',
  });
  await app.register(createUsersSelfServicePlugin(users, { resolveActor, bodyLimit: 2048 }), {
    prefix: '/account',
  });
  await app.ready();
  return {
    send: async (method, path, init = {}) => {
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      let payload: string | undefined;
      if (init.raw !== undefined) payload = init.raw;
      else if (init.body !== undefined) payload = JSON.stringify(init.body);
      if (payload !== undefined) headers['content-type'] = 'application/json';
      const r = await app.inject({
        method: method as 'GET',
        url: path,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      const h = new Headers();
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h.set(k, String(v));
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: h };
    },
    close: () => app.close(),
  };
}

function honoHarness(users: UsersService): Harness {
  const app = new Hono();
  const resolveActor = (c: { req: { header(name: string): string | undefined } }) =>
    actorFromHeader(c.req.header('x-user-id'));
  app.route('/admin', createUsersAdminApp(users, { resolveActor, bodyLimit: 2048 }));
  app.route('/account', createUsersSelfServiceApp(users, { resolveActor, bodyLimit: 2048 }));
  return {
    send: async (method, path, init) => toRes(await app.request(path, initFor(init, method))),
    close: async () => {},
  };
}

function fetchHarness(users: UsersService): Harness {
  const resolveActor = (req: Request) => actorFromHeader(req.headers.get('x-user-id'));
  const admin = createUsersAdminHandler(users, {
    resolveActor,
    basePath: '/admin',
    bodyLimit: 2048,
  });
  const self = createUsersSelfServiceHandler(users, {
    resolveActor,
    basePath: '/account/',
    bodyLimit: 2048,
  });
  return {
    send: async (method, path, init) => {
      const req = new Request(`http://localhost${path}`, initFor(init, method));
      return toRes(await (path.startsWith('/admin') ? admin(req) : self(req)));
    },
    close: async () => {},
  };
}

const adapters: Array<{ name: string; make(users: UsersService): Promise<Harness> | Harness }> = [
  { name: 'express 5 (no body parser)', make: (u) => expressHarness(express, u, false) },
  { name: 'express 5 (express.json)', make: (u) => expressHarness(express, u, true) },
  {
    name: 'express 4',
    make: (u) => expressHarness(express4 as unknown as typeof express, u, true),
  },
  {
    name: 'express 4 (no body parser)',
    make: (u) => expressHarness(express4 as unknown as typeof express, u, false),
  },
  { name: 'fastify', make: fastifyHarness },
  { name: 'hono', make: honoHarness },
  { name: 'fetch', make: fetchHarness },
];

for (const adapter of adapters) {
  describe(`HTTP adapter: ${adapter.name}`, () => {
    let h: Harness;
    let users: UsersService;
    let audit: FakeAudit;
    const admin = { 'x-user-id': 'admin' };

    beforeEach(async () => {
      await h?.close();
      ({ users, audit } = buildService());
      h = await adapter.make(users);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('authenticates and authorises admin routes through the PermissionChecker', async () => {
      const anon = await h.send('POST', '/admin/users', { body: { email: 'a@example.com' } });
      expect(anon.status).toBe(401);
      expect(anon.body.error.code).toBe('USERS_UNAUTHENTICATED');
      const reader = await h.send('POST', '/admin/users', {
        body: { email: 'a@example.com' },
        headers: { 'x-user-id': 'reader' },
      });
      expect(reader.status).toBe(403);
      expect(reader.body.error.code).toBe('USERS_FORBIDDEN');
      const created = await h.send('POST', '/admin/users', {
        body: { id: 'u-1', email: 'A@Example.com', profile: { displayName: 'Ada' } },
        headers: admin,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ id: 'u-1', email: 'a@example.com', version: 1 });
      expect(created.headers.get('etag')).toBe('"1"');
      expect(created.headers.get('cache-control')).toBe('no-store');
      const read = await h.send('GET', '/admin/users/u-1', { headers: { 'x-user-id': 'reader' } });
      expect(read.status).toBe(200);
      const list = await h.send('GET', '/admin/users?limit=1&search=ada', { headers: admin });
      expect(list.body.items).toHaveLength(1);
      expect(audit.events.find((e) => e.action === 'users.created')?.actor?.id).toBe('admin');
    });

    it('maps validation, conflicts and missing resources to JSON errors', async () => {
      await h.send('POST', '/admin/users', {
        body: { id: 'u-1', email: 'a@example.com' },
        headers: admin,
      });
      const dup = await h.send('POST', '/admin/users', {
        body: { email: 'A@example.com' },
        headers: admin,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('USERS_EMAIL_TAKEN');
      const invalid = await h.send('POST', '/admin/users', {
        body: { email: 'nope' },
        headers: admin,
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.details.issues[0].path).toBe('email');
      const missing = await h.send('GET', '/admin/users/nobody', { headers: admin });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('USERS_NOT_FOUND');
      const ok = await h.send('PATCH', '/admin/users/u-1/profile', {
        body: { displayName: 'New' },
        headers: { ...admin, 'if-match': '"1"' },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('etag')).toBe('"2"');
      const stale = await h.send('PATCH', '/admin/users/u-1/profile', {
        body: { displayName: 'Stale' },
        headers: { ...admin, 'if-match': '"1"' },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('USERS_VERSION_CONFLICT');
    });

    it('rejects malformed and oversized bodies', async () => {
      const bad = await h.send('POST', '/admin/users', { raw: '{"email":', headers: admin });
      expect(bad.status).toBe(400);
      const big = await h.send('POST', '/admin/users', {
        body: { email: 'big@example.com', metadata: { x: 'y'.repeat(5000) } },
        headers: admin,
      });
      expect(big.status).toBe(413);
    });

    it('runs suspension, invitation and deletion flows over HTTP', async () => {
      await h.send('POST', '/admin/users', {
        body: { id: 'u-1', email: 'a@example.com' },
        headers: admin,
      });
      const until = new Date(Date.UTC(2026, 9, 1)).toISOString();
      const suspended = await h.send('POST', '/admin/users/u-1/suspend', {
        body: { reason: 'abuse', until },
        headers: admin,
      });
      expect(suspended.status).toBe(200);
      expect(suspended.body.status).toBe('suspended');
      const selfBlocked = await h.send('PATCH', '/account/me/profile', {
        body: { displayName: 'x' },
        headers: { 'x-user-id': 'u-1' },
      });
      expect(selfBlocked.status).toBe(403);
      expect(selfBlocked.body.error.code).toBe('USERS_SUSPENDED');
      const reactivated = await h.send('POST', '/admin/users/u-1/reactivate', { headers: admin });
      expect(reactivated.body.status).toBe('active');

      const invite = await h.send('POST', '/admin/invitations', {
        body: { email: 'new@example.com', roles: ['editor'] },
        headers: admin,
      });
      expect(invite.status).toBe(201);
      expect(invite.body.delivery).toBe('manual');
      const accepted = await h.send('POST', '/account/invitations/accept', {
        body: { token: invite.body.token, profile: { displayName: 'Newbie' } },
        headers: { 'x-user-id': 'auth-9' },
      });
      expect(accepted.status).toBe(201);
      expect(accepted.body.user).toMatchObject({ id: 'auth-9', email: 'new@example.com' });
      const repeat = await h.send('POST', '/account/invitations/accept', {
        body: { token: invite.body.token },
      });
      expect(repeat.status).toBe(200);
      expect(repeat.body.created).toBe(false);
      const resend = await h.send(
        'POST',
        `/admin/invitations/${invite.body.invitation.id}/resend`,
        { headers: admin },
      );
      expect(resend.status).toBe(409);
      const invList = await h.send('GET', '/admin/invitations?status=accepted', { headers: admin });
      expect(invList.body.items).toHaveLength(1);

      const del = await h.send('POST', '/admin/users/u-1/deletion', {
        body: { reason: 'request' },
        headers: admin,
      });
      expect(del.body.status).toBe('deleted');
      const early = await h.send('POST', '/admin/users/u-1/purge', { body: {}, headers: admin });
      expect(early.status).toBe(409);
      const forced = await h.send('POST', '/admin/users/u-1/purge', {
        body: { force: true },
        headers: admin,
      });
      expect(forced.body).toEqual({ purged: true, policy: 'anonymise' });
    });

    it('serves the self-service API for the resolved actor', async () => {
      await users.createUser({ id: 'me-1', email: 'me@example.com', status: 'pending' });
      expect((await h.send('GET', '/account/me')).status).toBe(401);
      const me = await h.send('GET', '/account/me', { headers: { 'x-user-id': 'me-1' } });
      expect(me.body).toMatchObject({ id: 'me-1', status: 'pending' });
      const prefs = await h.send('PATCH', '/account/me/preferences', {
        body: { theme: 'dark' },
        headers: { 'x-user-id': 'me-1' },
      });
      expect(prefs.status).toBe(200);
      expect(prefs.body).toEqual({ theme: 'dark' });
      const badPref = await h.send('PATCH', '/account/me/preferences', {
        body: { theme: 'neon' },
        headers: { 'x-user-id': 'me-1' },
      });
      expect(badPref.status).toBe(400);
      const { token } = await users.createActivationToken('me-1');
      const activated = await h.send('POST', '/account/activate', { body: { token } });
      expect(activated.body.status).toBe('active');
      const reused = await h.send('POST', '/account/activate', { body: { token } });
      expect(reused.status).toBe(400);
      expect(reused.body.error.code).toBe('USERS_TOKEN_INVALID');
      const activity = await h.send('GET', '/account/me/activity?limit=2', {
        headers: { 'x-user-id': 'me-1' },
      });
      expect(activity.body.items.length).toBeGreaterThan(0);
      const exported = await h.send('GET', '/account/me/export', {
        headers: { 'x-user-id': 'me-1' },
      });
      expect(exported.body.format).toBe('aspec.users.export');
      const del = await h.send('POST', '/account/me/deletion', {
        body: { reason: 'bye' },
        headers: { 'x-user-id': 'me-1' },
      });
      expect(del.body.status).toBe('deleted');
      const cancel = await h.send('DELETE', '/account/me/deletion', {
        headers: { 'x-user-id': 'me-1' },
      });
      expect(cancel.body.status).toBe('active');
      const unknownUser = await h.send('GET', '/account/me', { headers: { 'x-user-id': 'ghost' } });
      expect(unknownUser.status).toBe(404);
    });

    it('handles unknown routes and wrong methods', async () => {
      const wrong = await h.send('DELETE', '/admin/users', { headers: admin });
      expect(wrong.status).toBe(
        adapter.name.startsWith('fastify') || adapter.name === 'hono' ? 404 : 405,
      );
      const unknown = await h.send('GET', '/admin/nothing-here', { headers: admin });
      expect(unknown.status).toBe(404);
      if (adapter.name.startsWith('express')) expect(unknown.body).toEqual({ fallthrough: true });
    });
  });
}

describe('router construction', () => {
  it('requires a PermissionChecker for admin routers and resolveActor for all', () => {
    const users = createUsers({ store: createMemoryUsersStore() });
    const resolveActor = () => null;
    expect(() => createUsersAdminRouter(users, { resolveActor })).toThrow(/permissions/);
    expect(() => createUsersAdminHandler(users, { resolveActor })).toThrow(/permissions/);
    expect(() => createUsersAdminApp(users, { resolveActor })).toThrow(/permissions/);
    expect(() => createUsersAdminPlugin(users, { resolveActor })).toThrow(/permissions/);
    expect(() => createUsersSelfServiceRouter(users, {} as never)).toThrow(/resolveActor/);
    expect(() => createUsersSelfServiceHandler(users, { resolveActor, basePath: 'x' })).toThrow(
      /basePath/,
    );
    expect(() => createUsersSelfServiceHandler(users, { resolveActor, bodyLimit: 0 })).toThrow(
      /bodyLimit/,
    );
  });
});
