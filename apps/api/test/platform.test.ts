import { afterEach, describe, expect, it } from 'vitest';
import { MAIL_TRANSPORT_CATALOGUE } from '../src/mail/index.js';
import { createTestContext, destroyTestContext, request, type TestContext } from './helpers.js';

describe('platform capability map', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('describes implemented and planned capabilities', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/v1/platform');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      product: string;
      setupRequired: boolean;
      capabilities: { mail: { implemented: boolean; ownsMailboxes: boolean } };
      mailTransports: typeof MAIL_TRANSPORT_CATALOGUE;
    };
    expect(body.product).toBe('ASPECTenant');
    expect(body.setupRequired).toBe(true);
    expect(body.capabilities.mail.implemented).toBe(true);
    expect(body.capabilities.mail.ownsMailboxes).toBe(true);
    expect(body.mailTransports).toHaveLength(MAIL_TRANSPORT_CATALOGUE.length);
  });
});
