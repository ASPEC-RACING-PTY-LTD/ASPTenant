import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

describe('admin directory', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('rejects unauthenticated directory reads', async () => {
    ctx = await createTestContext();
    const response = await request(ctx, '/api/v1/users');
    expect(response.status).toBe(401);
  });

  it('creates users, groups, domains, applications and queries audit', async () => {
    ctx = await createTestContext();
    const cookie = await setupOwner(ctx);
    const headers = { cookie };

    const settingsGet = await request(ctx, '/api/v1/settings', { headers });
    expect(settingsGet.status).toBe(200);
    expect(
      ((await settingsGet.json()) as { organisation: { name: string } }).organisation.name,
    ).toBe('Contoso');

    const users = await request(ctx, '/api/v1/users', { headers });
    expect(users.status).toBe(200);
    const userList = (await users.json()) as {
      items: Array<{ email: string; mailboxId: string | null }>;
    };
    expect(userList.items).toHaveLength(1);
    expect(userList.items[0]?.email).toBe('owner@example.com');
    // No verified domain yet, so no mailbox record was created for the owner.
    expect(userList.items[0]?.mailboxId).toBeNull();

    const createdUser = await request(ctx, '/api/v1/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: 'member@example.com',
        password: 'correct-horse-battery',
        displayName: 'Member',
      }),
    });
    expect(createdUser.status).toBe(201);
    const member = (await createdUser.json()) as { id: string };

    const group = await request(ctx, '/api/v1/groups', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Finance', kind: 'security' }),
    });
    expect(group.status).toBe(201);
    const groupBody = (await group.json()) as { id: string };

    const added = await request(ctx, `/api/v1/groups/${groupBody.id}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: member.id }),
    });
    expect(added.status).toBe(201);

    const domain = await request(ctx, '/api/v1/domains', {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname: 'mail.example.com' }),
    });
    expect(domain.status).toBe(201);
    const domainBody = (await domain.json()) as { id: string; status: string; primary: boolean };
    expect(domainBody.status).toBe('pending');
    expect(domainBody.primary).toBe(true);

    const unverified = await request(ctx, `/api/v1/domains/${domainBody.id}/verify`, {
      method: 'POST',
      headers,
    });
    expect(unverified.status).toBe(422);

    const pending = (await (await request(ctx, '/api/v1/domains', { headers })).json()) as {
      items: Array<{ verification: { name: string; value: string } }>;
    };
    const record = pending.items[0]?.verification;
    expect(record?.name).toBe('_aspectenant.mail.example.com');
    ctx.dns.set(record?.name ?? '', [record?.value ?? '']);

    const verified = await request(ctx, `/api/v1/domains/${domainBody.id}/verify`, {
      method: 'POST',
      headers,
    });
    expect(verified.status).toBe(200);
    expect(((await verified.json()) as { status: string }).status).toBe('verified');

    const application = await request(ctx, '/api/v1/applications', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'SoftDock preview',
        redirectUris: ['http://localhost:4000/callback'],
      }),
    });
    expect(application.status).toBe(201);
    expect(((await application.json()) as { clientId: string }).clientId).toMatch(/^at_/);

    const mailboxes = await request(ctx, '/api/v1/mailboxes', { headers });
    expect(mailboxes.status).toBe(200);
    const mailboxBody = (await mailboxes.json()) as {
      items: Array<{ primaryAddress: string }>;
      messageStore: boolean;
    };
    expect(mailboxBody.messageStore).toBe(false);
    expect(mailboxBody.items).toHaveLength(0);

    const offDomain = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'shared', primaryAddress: 'help@example.com' }),
    });
    expect(offDomain.status).toBe(422);

    const shared = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'shared',
        primaryAddress: 'help@mail.example.com',
        displayName: 'Help',
      }),
    });
    expect(shared.status).toBe(201);

    const staffer = await request(ctx, '/api/v1/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'staff@mail.example.com', password: 'correct-horse-battery' }),
    });
    expect(staffer.status).toBe(201);
    expect(((await staffer.json()) as { mailboxId: string | null }).mailboxId).toMatch(/\S/);

    const inUse = await request(ctx, `/api/v1/domains/${domainBody.id}`, {
      method: 'DELETE',
      headers,
    });
    expect(inUse.status).toBe(409);

    const settings = await request(ctx, '/api/v1/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Contoso' }),
    });
    expect(settings.status).toBe(200);
    expect(((await settings.json()) as { organisation: { name: string } }).organisation.name).toBe(
      'Contoso',
    );

    const audit = await request(ctx, '/api/v1/audit?actionPrefix=directory.', { headers });
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as { items: Array<{ action: string }> };
    expect(auditBody.items.some((item) => item.action === 'directory.group.created')).toBe(true);

    const system = await request(ctx, '/api/v1/system', { headers });
    expect(system.status).toBe(200);
    const systemBody = (await system.json()) as { counts: { users: number; groups: number } };
    expect(systemBody.counts.users).toBe(3);
    expect(systemBody.counts.groups).toBe(1);

    const platform = await request(ctx, '/api/v1/platform');
    const platformBody = (await platform.json()) as {
      capabilities: {
        mail: { implemented: boolean; ownsMailboxes: boolean };
        users: { implemented: boolean };
        groups: { implemented: boolean };
      };
    };
    expect(platformBody.capabilities.mail.implemented).toBe(false);
    expect(platformBody.capabilities.mail.ownsMailboxes).toBe(true);
    expect(platformBody.capabilities.users.implemented).toBe(true);
    expect(platformBody.capabilities.groups.implemented).toBe(true);
  });

  it('suspends a user so they cannot sign in', async () => {
    ctx = await createTestContext();
    const cookie = await setupOwner(ctx);
    const createdUser = await request(ctx, '/api/v1/users', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({
        email: 'locked@example.com',
        password: 'correct-horse-battery',
      }),
    });
    const member = (await createdUser.json()) as { id: string };

    const suspended = await request(ctx, `/api/v1/users/${member.id}/suspend`, {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ reason: 'Policy' }),
    });
    expect(suspended.status).toBe(200);

    const login = await request(ctx, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'locked@example.com',
        password: 'correct-horse-battery',
      }),
    });
    expect(login.status).toBeGreaterThanOrEqual(400);
  });
});
