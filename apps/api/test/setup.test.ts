import { afterEach, describe, expect, it } from 'vitest';
import {
  cookieHeader,
  createTestContext,
  destroyTestContext,
  request,
  type TestContext,
} from './helpers.js';

describe('setup and session', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('creates the first owner, then refuses a second setup', async () => {
    ctx = await createTestContext();

    const open = await request(ctx, '/api/v1/setup');
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ required: true });

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
    const createdBody = (await created.json()) as { accountId: string };
    expect(createdBody.accountId).toMatch(/\S/);

    const closed = await request(ctx, '/api/v1/setup', {
      method: 'POST',
      body: JSON.stringify({
        email: 'other@example.com',
        password: 'correct-horse-battery',
        setupCode: 'ABCDE-FGHIJ',
      }),
    });
    expect(closed.status).toBe(409);

    const login = await request(ctx, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct-horse-battery',
      }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { status: string };
    expect(loginBody.status).toBe('authenticated');
    const cookie = cookieHeader(login);
    expect(cookie).toContain('aspectenant_session=');

    const session = await request(ctx, '/api/v1/session', {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as {
      account: { email: string };
      organisation: { slug: string; name: string };
      membership: { role: string };
    };
    expect(sessionBody.account.email).toBe('owner@example.com');
    expect(sessionBody.organisation.slug).toBe('default');
    expect(sessionBody.organisation.name).toBe('Contoso');
    expect(sessionBody.membership.role).toBe('owner');
  });

  it('requires the setup code from the server log', async () => {
    ctx = await createTestContext();
    expect(ctx.platform.setupCode).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    const wrong = await request(ctx, '/api/v1/setup', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct-horse-battery',
        setupCode: '00000-00000',
      }),
    });
    expect(wrong.status).toBe(403);
  });

  it('rejects unauthenticated session reads', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/v1/session');
    expect(response.status).toBe(401);
  });
});
