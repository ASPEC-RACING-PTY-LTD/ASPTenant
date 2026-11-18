import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  json,
  request,
  type TestContext,
  twoTenants,
} from './helpers.js';

interface Settings {
  canShare: boolean;
  outbound: {
    kind: string;
    shared: {
      tenantId: string;
      name: string | null;
      kind: string | null;
      problem: string | null;
    } | null;
  };
}

describe('sharing credentials between organisations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await destroyTestContext(ctx);
  });

  /**
   * Alice operates the installation and owns Contoso (A). Bob owns the client organisation
   * Fabrikam (B), where Alice is also an administrator, like the operator's own client tenants.
   */
  async function setup() {
    const tenants = await twoTenants(ctx);
    const added = await request(ctx, `/api/v1/tenants/${tenants.tenantB}/members`, {
      method: 'POST',
      headers: { cookie: tenants.alice },
      body: JSON.stringify({ email: 'alice@contoso.test', role: 'tenant.admin' }),
    });
    expect(added.status).toBe(201);
    const inA = { cookie: tenants.alice, 'x-aspectenant-tenant': tenants.tenantA };
    const aliceInB = { cookie: tenants.alice, 'x-aspectenant-tenant': tenants.tenantB };
    const bobInB = { cookie: tenants.bob, 'x-aspectenant-tenant': tenants.tenantB };
    return { ...tenants, inA, aliceInB, bobInB };
  }

  const saveMail = (headers: Record<string, string>, body: unknown) =>
    request(ctx, '/api/v1/mail/settings', { method: 'PUT', headers, body: JSON.stringify(body) });
  const getMail = async (headers: Record<string, string>) =>
    json<Settings>(await request(ctx, '/api/v1/mail/settings', { headers }));

  it('lets only a platform operator lend sending, and follows the lender', async () => {
    const { tenantA, inA, aliceInB, bobInB } = await setup();
    const relay = {
      kind: 'smtp',
      smtp: {
        host: 'smtp.relay.test',
        port: 587,
        security: 'starttls',
        username: 'u',
        password: 'p',
      },
    };

    // Nothing to lend yet.
    expect((await saveMail(aliceInB, { kind: 'shared', sharedFrom: tenantA })).status).toBe(422);
    expect((await saveMail(inA, relay)).status).toBe(200);

    const sources = await json<{ items: Array<{ id: string; sending: string | null }> }>(
      await request(ctx, '/api/v1/integrations/shared-sources', { headers: aliceInB }),
    );
    expect(sources.items).toEqual([
      { id: tenantA, name: 'Contoso', sending: 'smtp', cloudflare: false },
    ]);
    expect(
      (await request(ctx, '/api/v1/integrations/shared-sources', { headers: bobInB })).status,
    ).toBe(403);

    // The client's own owner cannot borrow the operator's setup, and nobody can share with self.
    expect((await getMail(bobInB)).canShare).toBe(false);
    expect((await saveMail(bobInB, { kind: 'shared', sharedFrom: tenantA })).status).toBe(403);
    expect((await saveMail(inA, { kind: 'shared', sharedFrom: tenantA })).status).toBe(422);

    const shared = await saveMail(aliceInB, { kind: 'shared', sharedFrom: tenantA });
    expect(shared.status).toBe(200);
    const view = await getMail(bobInB);
    expect(view.outbound.kind).toBe('shared');
    expect(view.outbound.shared).toEqual({
      tenantId: tenantA,
      name: 'Contoso',
      kind: 'smtp',
      problem: null,
    });
    // The lender's secrets are never part of the borrower's view.
    expect(JSON.stringify(view)).not.toContain('smtp.relay.test');

    // The client's administrators may save other changes while sharing, and switch away.
    expect((await saveMail(bobInB, { kind: 'shared' })).status).toBe(200);

    // When the lender stops sending, the borrower is told why.
    expect((await saveMail(inA, { kind: 'none' })).status).toBe(200);
    expect((await getMail(bobInB)).outbound.shared?.problem).toBe(
      'Contoso has no working Cloudflare or SMTP sending setup.',
    );

    expect((await saveMail(bobInB, { kind: 'none' })).status).toBe(200);
    expect((await getMail(bobInB)).outbound.shared).toBeNull();
    // Having switched away, Bob cannot switch back by himself.
    expect((await saveMail(bobInB, { kind: 'shared', sharedFrom: tenantA })).status).toBe(403);

    const audit = await json<{ items: Array<{ action: string; changes?: { after?: unknown } }> }>(
      await request(ctx, '/api/v1/audit?limit=50', { headers: bobInB }),
    );
    expect(audit.items.some((item) => item.action === 'mail.settings.updated')).toBe(true);
  });

  it('lends a Cloudflare token for DNS setup to an operator-chosen organisation', async () => {
    const { tenantA, inA, aliceInB, bobInB } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (String(headers.authorization) !== 'Bearer operator-token') {
          return new Response(JSON.stringify({ success: false, errors: [] }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              { id: 'z1', name: 'contoso.test' },
              { id: 'z2', name: 'fabrikam.test' },
            ],
            result_info: { total_pages: 1 },
          }),
        );
      }),
    );
    const share = (headers: Record<string, string>) =>
      request(ctx, '/api/v1/integrations/cloudflare/shared', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ from: tenantA }),
      });

    expect((await share(aliceInB)).status).toBe(422);
    const connected = await request(ctx, '/api/v1/integrations/cloudflare', {
      method: 'PUT',
      headers: inA,
      body: JSON.stringify({ token: 'operator-token' }),
    });
    expect(connected.status).toBe(200);

    expect((await share(bobInB)).status).toBe(403);
    const shared = await share(aliceInB);
    expect(shared.status).toBe(200);
    const result = await json<{ connected: boolean; zones: string[]; sharedFrom: unknown }>(shared);
    expect(result.connected).toBe(true);
    expect(result.zones).toContain('fabrikam.test');
    expect(result.sharedFrom).toEqual({ id: tenantA, name: 'Contoso' });

    const bobView = await json<{ connected: boolean; canShare: boolean }>(
      await request(ctx, '/api/v1/integrations/cloudflare', { headers: bobInB }),
    );
    expect(bobView).toMatchObject({ connected: true, canShare: false });

    // Removing the lender's token disconnects the borrower too.
    await request(ctx, '/api/v1/integrations/cloudflare', { method: 'DELETE', headers: inA });
    const after = await json<{ connected: boolean; problem: string }>(
      await request(ctx, '/api/v1/integrations/cloudflare', { headers: bobInB }),
    );
    expect(after.connected).toBe(false);
    expect(after.problem).toBe('Contoso no longer has a Cloudflare token to share.');

    // The client's owner can stop using it.
    expect(
      (await request(ctx, '/api/v1/integrations/cloudflare', { method: 'DELETE', headers: bobInB }))
        .status,
    ).toBe(200);
  });
});
