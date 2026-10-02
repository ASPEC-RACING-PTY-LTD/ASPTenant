import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import express5 from 'express';
import express4 from 'express4';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createExpressApi } from '../src/adapters/express.js';
import { fastifyApi } from '../src/adapters/fastify.js';
import { createFetchApi } from '../src/adapters/fetch.js';
import { createHonoApi } from '../src/adapters/hono.js';
import { createApi, defineRoute, ok } from '../src/index.js';

async function listen(app: RequestListener) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function sampleApi() {
  return createApi({
    info: { title: 'A', version: '1' },
    routes: [
      defineRoute({
        method: 'get',
        path: '/hello',
        request: { query: z.object({ name: z.string().min(1) }) },
        handler: async ({ request }) => ok({ hello: request.query!.name }),
      }),
    ],
  });
}

describe.each([
  ['express 4', express4],
  ['express 5', express5],
])('%s adapter', (_label, express) => {
  let closer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closer?.();
    closer = undefined;
  });

  it('serves routes', async () => {
    const api = sampleApi();
    const app = express();
    app.use(createExpressApi(api));
    const server = await listen(app as RequestListener);
    closer = () => server.close();
    const res = await fetch(`${server.url}/hello?name=Ada`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'Ada' });
  });
});

describe('fastify adapter', () => {
  it('serves routes', async () => {
    const api = sampleApi();
    const app = Fastify();
    await app.register(fastifyApi, { api });
    const res = await app.inject({ method: 'GET', url: '/hello?name=Ada' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'Ada' });
    await app.close();
  });
});

describe('hono and fetch adapters', () => {
  it('hono', async () => {
    const app = createHonoApi(sampleApi());
    const res = await app.request('/hello?name=Ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'Ada' });
  });

  it('fetch', async () => {
    const handler = createFetchApi(sampleApi());
    const res = await handler(new Request('http://local/hello?name=Ada'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'Ada' });
  });
});
