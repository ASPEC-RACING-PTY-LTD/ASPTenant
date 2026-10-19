import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addVerifiedDomain,
  createTestContext,
  destroyTestContext,
  json,
  PASSWORD,
  request,
  setupOwner,
  signIn,
  type TestContext,
  userIdOf,
} from './helpers.js';

const NEW_PASSWORD = 'a-brand-new-passphrase';

/**
 * One organisation: alice@contoso.test is the owner, carol an administrator and dave a member.
 * Alice has a personal mailbox.
 */
async function organisation(ctx: TestContext) {
  const alice = await setupOwner(ctx, 'alice@contoso.test', 'Contoso');
  const owner = { cookie: alice };
  await addVerifiedDomain(ctx, owner, 'contoso.test');
  const aliceId = await userIdOf(ctx, alice);
  const create = async (email: string, role: string | null) => {
    const response = await request(ctx, '/api/v1/users', {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ email, password: PASSWORD, role }),
    });
    expect(response.status).toBe(201);
    return json<{ id: string; mailboxId: string | null }>(response);
  };
  const carolUser = await create('carol@contoso.test', 'tenant.admin');
  const daveUser = await create('dave@contoso.test', null);
  const mailbox = await request(ctx, '/api/v1/mailboxes', {
    method: 'POST',
    headers: owner,
    body: JSON.stringify({ kind: 'user', userId: aliceId, primaryAddress: 'alice@contoso.test' }),
  });
  expect(mailbox.status).toBe(201);
  const aliceMailbox = (await json<{ id: string }>(mailbox)).id;
  const carol = await signIn(ctx, 'carol@contoso.test');
  return { alice, aliceId, aliceMailbox, carol, carolId: carolUser.id, dave: daveUser };
}

describe('owners and administrators', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await destroyTestContext(ctx);
  });

  it('keeps administrators away from an owner, their mailbox and its access', async () => {
    const { aliceId, aliceMailbox, carol, carolId } = await organisation(ctx);
    const admin = { cookie: carol };
    const attempts: Array<[string, string, unknown]> = [
      ['PATCH', `/api/v1/users/${aliceId}`, { displayName: 'Taken over' }],
      ['POST', `/api/v1/users/${aliceId}/password`, { password: NEW_PASSWORD }],
      ['POST', `/api/v1/users/${aliceId}/mfa/reset`, undefined],
      ['GET', `/api/v1/users/${aliceId}/sessions`, undefined],
      ['PUT', `/api/v1/users/${aliceId}/role`, { role: 'tenant.auditor' }],
      ['POST', `/api/v1/mail/admin/mailboxes/${aliceMailbox}/members`, { userId: carolId }],
      ['PATCH', `/api/v1/mailboxes/${aliceMailbox}`, { displayName: 'Mine now' }],
      ['POST', `/api/v1/mailboxes/${aliceMailbox}/aliases`, { alias: 'boss@contoso.test' }],
      ['DELETE', `/api/v1/mailboxes/${aliceMailbox}`, undefined],
      [
        'POST',
        '/api/v1/mail/credentials',
        {
          kind: 'service',
          grants: [{ mailboxId: aliceMailbox, read: true, write: false, send: false }],
        },
      ],
    ];
    for (const [method, path, body] of attempts) {
      const response = await request(ctx, path, {
        method,
        headers: admin,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    // Promoting anyone to owner is an owner's decision too.
    const promote = await request(ctx, `/api/v1/users/${carolId}/role`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ role: 'tenant.owner' }),
    });
    expect(promote.status).toBe(403);
  });

  it('lets administrators change everything about other people', async () => {
    const { carol, dave } = await organisation(ctx);
    const admin = { cookie: carol };

    const renamed = await request(ctx, `/api/v1/users/${dave.id}`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ displayName: 'Dave Smith', email: 'david@contoso.test' }),
    });
    expect(renamed.status).toBe(200);
    expect(await json<{ email: string; displayName: string }>(renamed)).toMatchObject({
      email: 'david@contoso.test',
      displayName: 'Dave Smith',
    });

    const password = await request(ctx, `/api/v1/users/${dave.id}/password`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ password: NEW_PASSWORD }),
    });
    expect(password.status).toBe(204);
    const oldLogin = await request(ctx, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'david@contoso.test', password: PASSWORD }),
    });
    expect(oldLogin.status).toBeGreaterThanOrEqual(400);
    await signIn(ctx, 'david@contoso.test', NEW_PASSWORD);

    const reset = await request(ctx, `/api/v1/users/${dave.id}/mfa/reset`, {
      method: 'POST',
      headers: admin,
    });
    expect(reset.status).toBe(204);

    // The personal mailbox follows the new name; its address is changed separately.
    const mailboxes = await json<{ items: Array<{ id: string; userId: string | null }> }>(
      await request(ctx, '/api/v1/mailboxes', { headers: admin }),
    );
    const daveMailbox = mailboxes.items.find((item) => item.userId === dave.id);
    expect(daveMailbox).toBeDefined();
    const moved = await request(ctx, `/api/v1/mailboxes/${daveMailbox?.id}`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ primaryAddress: 'david@contoso.test' }),
    });
    expect(moved.status).toBe(200);
    expect(
      await json<{ primaryAddress: string; displayName: string; aliases: string[] }>(moved),
    ).toMatchObject({
      primaryAddress: 'david@contoso.test',
      displayName: 'Dave Smith',
      aliases: ['dave@contoso.test'],
    });
  });

  it('lets an owner add and remove another owner', async () => {
    const { alice, aliceId, carol, carolId } = await organisation(ctx);
    const owner = { cookie: alice };

    const promoted = await request(ctx, `/api/v1/users/${carolId}/role`, {
      method: 'PUT',
      headers: owner,
      body: JSON.stringify({ role: 'tenant.owner' }),
    });
    expect(promoted.status).toBe(200);
    expect(await json<{ orgRole: string; roles: string[] }>(promoted)).toMatchObject({
      orgRole: 'owner',
      roles: ['tenant.owner'],
    });

    // A co-owner may change the first owner.
    const renamed = await request(ctx, `/api/v1/users/${aliceId}`, {
      method: 'PATCH',
      headers: { cookie: carol },
      body: JSON.stringify({ displayName: 'Alice' }),
    });
    expect(renamed.status).toBe(200);

    const demoted = await request(ctx, `/api/v1/users/${carolId}/role`, {
      method: 'PUT',
      headers: owner,
      body: JSON.stringify({ role: 'tenant.admin' }),
    });
    expect(demoted.status).toBe(200);
    expect(await json<{ orgRole: string; roles: string[] }>(demoted)).toMatchObject({
      orgRole: 'admin',
      roles: ['tenant.admin'],
    });
  });

  it('replaces and removes the Cloudflare token of the organisation', async () => {
    const { alice } = await organisation(ctx);
    const owner = { cookie: alice };
    // Token value to the zones it can see. Unknown tokens fail authentication.
    const zones: Record<string, string[]> = {
      'old-token-1': ['previous-account.test'],
      'fresh-token-1': ['contoso.test'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const token = String(headers.authorization).slice(7);
        const names = zones[token];
        if (!names) {
          return new Response(
            JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Invalid token' }] }),
            { status: 401 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: names.map((name, index) => ({ id: `z${index}`, name })),
            result_info: { total_pages: 1 },
          }),
        );
      }),
    );

    const connect = (token: string) =>
      request(ctx, '/api/v1/integrations/cloudflare', {
        method: 'PUT',
        headers: owner,
        body: JSON.stringify({ token }),
      });
    expect((await connect('old-token-1')).status).toBe(200);

    // The old account was wiped: its token stops working and the check says so.
    delete zones['old-token-1'];
    const broken = await json<{ connected: boolean; problem: string | null }>(
      await request(ctx, '/api/v1/integrations/cloudflare?check=1', { headers: owner }),
    );
    expect(broken.connected).toBe(true);
    expect(broken.problem).toMatch(/rejected the API token/);

    // A token that cannot authenticate is refused.
    expect((await connect('unknown-token-1')).status).toBe(422);

    const replaced = await connect('fresh-token-1');
    expect(replaced.status).toBe(200);
    expect(await json<{ zones: string[] }>(replaced)).toMatchObject({ zones: ['contoso.test'] });
    const healthy = await json<{ problem: string | null; zones: string[] }>(
      await request(ctx, '/api/v1/integrations/cloudflare?check=1', { headers: owner }),
    );
    expect(healthy).toMatchObject({ problem: null, zones: ['contoso.test'] });

    const removed = await request(ctx, '/api/v1/integrations/cloudflare', {
      method: 'DELETE',
      headers: owner,
    });
    expect(removed.status).toBe(200);
    expect(
      await json<{ connected: boolean }>(
        await request(ctx, '/api/v1/integrations/cloudflare', { headers: owner }),
      ),
    ).toMatchObject({ connected: false });

    const audit = await json<{ items: Array<{ action: string }> }>(
      await request(ctx, '/api/v1/audit?actionPrefix=integration.cloudflare', { headers: owner }),
    );
    expect(audit.items.map((item) => item.action).sort()).toEqual([
      'integration.cloudflare.connected',
      'integration.cloudflare.disconnected',
      'integration.cloudflare.replaced',
    ]);
  });

  it('clears saved mail secrets and turns inbound mail off', async () => {
    const { alice } = await organisation(ctx);
    const owner = { cookie: alice };
    const saved = await request(ctx, '/api/v1/mail/settings', {
      method: 'PUT',
      headers: owner,
      body: JSON.stringify({
        kind: 'cloudflare',
        cloudflareToken: 'email-sending-token',
        smtp: { host: 'smtp.contoso.test', port: 587, security: 'starttls', password: 'relay-pw' },
      }),
    });
    expect(saved.status).toBe(200);

    const cleared = await request(ctx, '/api/v1/mail/settings', {
      method: 'PUT',
      headers: owner,
      body: JSON.stringify({ kind: 'none', clearCloudflareToken: true, clearSmtpPassword: true }),
    });
    expect(cleared.status).toBe(200);
    expect(
      await json<{ outbound: { kind: string; cloudflare: { hasToken: boolean } } }>(cleared),
    ).toMatchObject({ outbound: { kind: 'none', cloudflare: { hasToken: false } } });
    const view = await json<{ outbound: { smtp: { host: string; hasPassword: boolean } } }>(
      await request(ctx, '/api/v1/mail/settings', { headers: owner }),
    );
    expect(view.outbound.smtp).toMatchObject({ host: 'smtp.contoso.test', hasPassword: false });

    const { token } = await json<{ token: string }>(
      await request(ctx, '/api/v1/mail/settings/ingest-token', { method: 'POST', headers: owner }),
    );
    const revoked = await request(ctx, '/api/v1/mail/settings/ingest-token', {
      method: 'DELETE',
      headers: owner,
    });
    expect(revoked.status).toBe(200);
    const ingest = await request(ctx, '/api/v1/mail/ingest', {
      method: 'POST',
      body: 'Subject: hi\r\n\r\nhello\r\n',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'message/rfc822',
        'x-envelope-to': 'alice@contoso.test',
      },
    });
    expect(ingest.status).toBe(401);
    const audit = await json<{ items: Array<{ action: string }> }>(
      await request(ctx, '/api/v1/audit?actionPrefix=mail.', { headers: owner }),
    );
    // Recorded against this organisation, so its own audit log shows them.
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining(['mail.settings.updated', 'mail.ingest_token.revoked']),
    );
  });
});
