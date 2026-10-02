import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, request, type TestContext } from './helpers.js';

describe('health endpoints', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('reports liveness without dependency checks', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/livez');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('reports readiness including the database', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/readyz');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      checks?: Record<string, { status: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.checks?.database?.status).toBe('ok');
  });
});
