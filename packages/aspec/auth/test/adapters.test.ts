import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthRouter } from '../src/adapters/express.js';
import { createAuthPlugin } from '../src/adapters/fastify.js';
import { createAuthFetchHandler } from '../src/adapters/fetch.js';
import { createAuthRoutes } from '../src/adapters/hono.js';
import { listen, type TestServer } from './helpers/http.js';
import { createTestAuth, STRONG_PASSWORD } from './helpers/setup.js';

const ORIGIN = 'http://127.0.0.1:3000';

function authOptions() {
  const { auth } = createTestAuth({
    tokens: {
      signing: { alg: 'HS256', secret: 'y'.repeat(32) },
      issuer: 'https://auth.test',
      audience: 'https://api.test',
    },
  });
  return {
    auth,
    http: {
      basePath: '/auth',
      allowedOrigins: [ORIGIN],
      modes: ['cookie', 'token'] as const,
      csrf: true,
      cookie: { secure: false, name: 'aspec_session' },
    },
  };
}

describe.each([
  ['express 4', express4, '4.22.3'],
  ['express 5', express5, '5.2.1'],
])('%s adapter', (_label, express, version) => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it(`registers and logs in (express ${version})`, async () => {
    const { auth, http } = authOptions();
    const app = express();
    app.use(createAuthRouter(auth, http));
    server = await listen(app);
    const reg = await fetch(`${server.url}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'e@example.com', password: STRONG_PASSWORD }),
    });
    expect(reg.status).toBe(202);
    const login = await fetch(`${server.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'e@example.com', password: STRONG_PASSWORD }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.getSetCookie?.() ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('aspec_session')]),
    );
    const csrf = await fetch(`${server.url}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: 'aspec_session=deadbeefdeadbeefdeadbeefdeadbeef',
      },
      body: JSON.stringify({ email: 'e@example.com', password: STRONG_PASSWORD }),
    });
    expect(csrf.status).toBe(403);
  });
});

describe('fastify adapter', () => {
  it('handles login via inject', async () => {
    const { auth, http } = authOptions();
    const app = Fastify();
    const plugin = createAuthPlugin(auth, http);
    await app.register(plugin);
    await auth.register({ email: 'f@example.com', password: STRONG_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      payload: { email: 'f@example.com', password: STRONG_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('hono adapter', () => {
  it('handles login via app.request', async () => {
    const { auth, http } = authOptions();
    const app = new Hono();
    const routes = createAuthRoutes(auth, http);
    app.route('/', routes.app);
    await auth.register({ email: 'h@example.com', password: STRONG_PASSWORD });
    const res = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'h@example.com', password: STRONG_PASSWORD }),
    });
    expect(res.status).toBe(200);
  });
});

describe('fetch adapter', () => {
  it('handles login', async () => {
    const { auth, http } = authOptions();
    const handler = createAuthFetchHandler(auth, http);
    await auth.register({ email: 'w@example.com', password: STRONG_PASSWORD });
    const res = await handler(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'w@example.com', password: STRONG_PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
