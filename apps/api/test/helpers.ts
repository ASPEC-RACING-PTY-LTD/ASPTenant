import { createDatabase } from '@aspec/db';
import { createNoopLogger } from '@aspec/observability';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { loadAppConfig } from '../src/config.js';
import { closePlatform, createPlatform, type Platform } from '../src/platform.js';

export interface TestContext {
  platform: Platform;
  app: ReturnType<typeof createApp>;
  origin: string;
}

export async function createTestContext(): Promise<TestContext> {
  const origin = 'http://127.0.0.1:8080';
  const config = loadAppConfig({
    ignoreFiles: true,
    processEnv: {
      DATABASE_URL: 'sqlite::memory:',
      PUBLIC_URL: origin,
      APP_NAME: 'ASPECTenant Test',
      LOG_LEVEL: 'error',
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: '3000',
    },
  });
  const database = await createDatabase({
    dialect: 'sqlite',
    filename: ':memory:',
    driver: 'node:sqlite',
  });
  const platform = await createPlatform({
    config,
    database,
    logger: createNoopLogger(),
  });
  return { platform, app: createApp(platform), origin };
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await closePlatform(ctx.platform);
}

export async function request(
  ctx: TestContext,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('origin') && init.method && init.method !== 'GET' && init.method !== 'HEAD') {
    headers.set('origin', ctx.origin);
  }
  return ctx.app.request(path, { ...init, headers });
}

export function cookieHeader(response: Response): string {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const cookies = getSetCookie ? getSetCookie() : [];
  if (cookies.length === 0) {
    const single = response.headers.get('set-cookie');
    return single ? (single.split(';', 1)[0] ?? '') : '';
  }
  return cookies.map((value) => value.split(';', 1)[0] ?? '').join('; ');
}

export async function setupOwner(ctx: TestContext): Promise<string> {
  const created = await request(ctx, '/api/v1/setup', {
    method: 'POST',
    body: JSON.stringify({
      email: 'owner@example.com',
      password: 'correct-horse-battery',
      setupCode: ctx.platform.setupCode,
      displayName: 'Owner',
      organisationName: 'Contoso',
    }),
  });
  expect(created.status).toBe(201);
  const login = await request(ctx, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'owner@example.com',
      password: 'correct-horse-battery',
    }),
  });
  expect(login.status).toBe(200);
  return cookieHeader(login);
}
