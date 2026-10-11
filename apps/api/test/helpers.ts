import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '@aspec/db';
import { createNoopLogger } from '@aspec/observability';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { loadAppConfig } from '../src/config.js';
import { closePlatform, createPlatform, type Platform } from '../src/platform.js';
import { listActiveTenants, withSystemTenant } from '../src/tenancy.js';

export interface TestContext {
  platform: Platform;
  app: ReturnType<typeof createApp>;
  origin: string;
  database: Database;
  /** Fake public DNS: TXT record name to values. */
  dns: Map<string, string[]>;
}

/** Drops every table the connected role owns. Used to give each PostgreSQL test a clean database. */
export async function resetPostgres(db: Database): Promise<void> {
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`,
  );
  for (const row of tables.rows) {
    await db.query(`DROP TABLE IF EXISTS public."${row.tablename}" CASCADE`);
  }
}

/**
 * SQLite in memory by default. With ASPECTENANT_TEST_ALL_POSTGRES=1 and
 * ASPECTENANT_TEST_DATABASE_URL set, every suite runs against PostgreSQL with row-level
 * security (run with --no-file-parallelism; each test resets the database).
 */
async function freshDatabase(): Promise<Database> {
  const url = process.env.ASPECTENANT_TEST_DATABASE_URL;
  if (process.env.ASPECTENANT_TEST_ALL_POSTGRES === '1' && url) {
    const db = await createDatabase({ url });
    await resetPostgres(db);
    return db;
  }
  return createDatabase({ dialect: 'sqlite', filename: ':memory:', driver: 'node:sqlite' });
}

/**
 * A second, independent database for tests that need two servers (backup and restore). In
 * PostgreSQL mode it uses ASPECTENANT_TEST_DATABASE_URL_2, because resetting the first
 * database would pull the data out from under the first server.
 */
export async function secondDatabase(): Promise<Database> {
  if (process.env.ASPECTENANT_TEST_ALL_POSTGRES === '1') {
    const url = process.env.ASPECTENANT_TEST_DATABASE_URL_2;
    if (!url) throw new Error('Set ASPECTENANT_TEST_DATABASE_URL_2 for two-server tests.');
    const db = await createDatabase({ url });
    await resetPostgres(db);
    return db;
  }
  return createDatabase({ dialect: 'sqlite', filename: ':memory:', driver: 'node:sqlite' });
}

export interface TestContextOptions {
  /** Extra environment for the app configuration. */
  env?: Record<string, string>;
  /** Reuse an existing database (for example to restart the platform on the same data). */
  database?: Database;
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aspectenant-test-'));
  const origin = options.env?.PUBLIC_URL ?? 'http://127.0.0.1:8080';
  const config = loadAppConfig({
    ignoreFiles: true,
    processEnv: {
      DATABASE_URL: 'sqlite::memory:',
      PUBLIC_URL: origin,
      APP_NAME: 'ASPECTenant Test',
      LOG_LEVEL: 'error',
      LISTEN_HOST: '127.0.0.1',
      LISTEN_PORT: '3000',
      DATA_DIR: dataDir,
      ...options.env,
    },
  });
  const database = options.database ?? (await freshDatabase());
  const dns = new Map<string, string[]>();
  const platform = await createPlatform({
    config,
    database,
    logger: createNoopLogger(),
    dns: {
      resolveTxt: async (name) => {
        const values = dns.get(name);
        if (!values) {
          throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
        }
        return values.map((value) => [value]);
      },
      resolveMx: async () => [],
    },
  });
  platform.backups.exitAfterRestore = false;
  platform.restart = () => undefined;
  return { platform, app: createApp(platform), origin, database, dns };
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

export const PASSWORD = 'correct-horse-battery';

export async function signIn(ctx: TestContext, email: string, password = PASSWORD) {
  const login = await request(ctx, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  return cookieHeader(login);
}

/** Runs first-time setup with the setup code and returns the owner's session cookie. */
export async function setupOwner(
  ctx: TestContext,
  email = 'owner@example.com',
  organisationName = 'Contoso',
): Promise<string> {
  const created = await request(ctx, '/api/v1/setup', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: PASSWORD,
      setupCode: ctx.platform.setupCode,
      displayName: 'Owner',
      organisationName,
    }),
  });
  expect(created.status).toBe(201);
  return signIn(ctx, email);
}

/** Publishes a TXT record in the fake DNS. */
export function publishTxt(ctx: TestContext, name: string, value: string): void {
  ctx.dns.set(name, [...(ctx.dns.get(name) ?? []), value]);
}

/** Adds a domain, publishes the TXT record it asks for, then verifies it. */
export async function addVerifiedDomain(
  ctx: TestContext,
  headers: Record<string, string>,
  hostname: string,
): Promise<{ id: string }> {
  const created = await request(ctx, '/api/v1/domains', {
    method: 'POST',
    headers,
    body: JSON.stringify({ hostname }),
  });
  expect(created.status).toBe(201);
  const domain = (await created.json()) as {
    id: string;
    verification: { name: string; value: string };
  };
  publishTxt(ctx, domain.verification.name, domain.verification.value);
  const verified = await request(ctx, `/api/v1/domains/${domain.id}/verify`, {
    method: 'POST',
    headers,
  });
  expect(verified.status).toBe(200);
  return { id: domain.id };
}

export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export interface Session {
  organisation: { id: string; slug: string } | null;
  roles: string[];
  permissions: string[];
  tenants: Array<{ id: string; slug: string; role: string }>;
  platform: { operator: boolean };
}

export interface Tenant {
  id: string;
  slug: string;
  status: string;
}

/**
 * Two tenants on one installation:
 * - Contoso (A): created by setup. alice@contoso.test is owner and platform operator.
 * - Fabrikam (B): created by the operator for bob@fabrikam.test, who is owner of B only.
 */
export async function twoTenants(ctx: TestContext) {
  const alice = await setupOwner(ctx, 'alice@contoso.test', 'Contoso');
  const aliceSession = await json<Session>(
    await request(ctx, '/api/v1/session', { headers: { cookie: alice } }),
  );
  const tenantA = aliceSession.organisation?.id ?? '';

  const createdB = await request(ctx, '/api/v1/tenants', {
    method: 'POST',
    headers: { cookie: alice },
    body: JSON.stringify({
      name: 'Fabrikam',
      owner: { email: 'bob@fabrikam.test', password: PASSWORD, displayName: 'Bob' },
    }),
  });
  expect(createdB.status).toBe(201);
  const tenantB = (await json<Tenant>(createdB)).id;
  const bob = await signIn(ctx, 'bob@fabrikam.test');
  return { alice, bob, tenantA, tenantB };
}

export async function userIdOf(ctx: TestContext, cookie: string): Promise<string> {
  const session = await json<{ user: { id: string } }>(
    await request(ctx, '/api/v1/session', { headers: { cookie } }),
  );
  return session.user.id;
}

/** Runs service calls inside a tenant (the oldest one by default), as requests and jobs do. */
export async function asTenant<T>(
  ctx: TestContext,
  fn: () => Promise<T>,
  tenantId?: string,
): Promise<T> {
  const id = tenantId ?? (await listActiveTenants(ctx.platform))[0]?.id;
  if (!id) throw new Error('No tenant exists yet');
  return withSystemTenant(ctx.platform, id, fn);
}
