import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addVerifiedDomain,
  createTestContext,
  destroyTestContext,
  json,
  PASSWORD,
  request,
  type Session,
  setupOwner,
  signIn,
  type TestContext,
  twoTenants,
  userIdOf,
} from './helpers.js';

describe('tenant isolation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('binds each account to its own tenant with tenant-scoped roles', async () => {
    const { alice, bob, tenantA, tenantB } = await twoTenants(ctx);
    expect(tenantA).not.toBe(tenantB);

    const bobSession = await json<Session>(
      await request(ctx, '/api/v1/session', { headers: { cookie: bob } }),
    );
    expect(bobSession.organisation?.id).toBe(tenantB);
    expect(bobSession.tenants.map((t) => t.id)).toEqual([tenantB]);
    expect(bobSession.roles).toEqual(['tenant.owner']);
    expect(bobSession.platform.operator).toBe(false);

    // Tenant owner B cannot reach platform administration.
    expect((await request(ctx, '/api/v1/tenants', { headers: { cookie: bob } })).status).toBe(403);

    // Alice is not a member of B, so being platform operator does not open B's data.
    const aliceInB = await request(ctx, '/api/v1/users', {
      headers: { cookie: alice, 'x-aspectenant-tenant': tenantB },
    });
    expect(aliceInB.status).toBe(403);

    // Bob choosing tenant A explicitly is refused.
    const bobInA = await request(ctx, '/api/v1/groups', {
      headers: { cookie: bob, 'x-aspectenant-tenant': tenantA },
    });
    expect(bobInA.status).toBe(403);
  });

  it('keeps users, groups, applications and audit separate', async () => {
    const { alice, bob } = await twoTenants(ctx);
    const aliceId = await userIdOf(ctx, alice);

    const group = await request(ctx, '/api/v1/groups', {
      method: 'POST',
      headers: { cookie: alice },
      body: JSON.stringify({ name: 'Contoso Finance', kind: 'security' }),
    });
    expect(group.status).toBe(201);
    const groupA = await json<{ id: string }>(group);
    const app = await request(ctx, '/api/v1/applications', {
      method: 'POST',
      headers: { cookie: alice },
      body: JSON.stringify({ name: 'Contoso app', redirectUris: ['https://app.contoso.test/cb'] }),
    });
    expect(app.status).toBe(201);
    const appA = await json<{ id: string }>(app);

    const bobUsers = await json<{ items: Array<{ email: string }> }>(
      await request(ctx, '/api/v1/users', { headers: { cookie: bob } }),
    );
    expect(bobUsers.items.map((u) => u.email)).toEqual(['bob@fabrikam.test']);
    expect(
      (await request(ctx, `/api/v1/users/${aliceId}`, { headers: { cookie: bob } })).status,
    ).toBe(404);
    for (const path of [`/api/v1/users/${aliceId}/suspend`, `/api/v1/users/${aliceId}/reinstate`]) {
      const response = await request(ctx, path, {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({ reason: 'cross-tenant attempt' }),
      });
      expect(response.status).toBe(404);
    }
    expect(
      (await request(ctx, `/api/v1/users/${aliceId}/sessions`, { headers: { cookie: bob } }))
        .status,
    ).toBe(404);

    const bobGroups = await json<{ items: unknown[] }>(
      await request(ctx, '/api/v1/groups', { headers: { cookie: bob } }),
    );
    expect(bobGroups.items).toHaveLength(0);
    expect(
      (await request(ctx, `/api/v1/groups/${groupA.id}`, { headers: { cookie: bob } })).status,
    ).toBe(404);
    expect(
      (
        await request(ctx, `/api/v1/groups/${groupA.id}`, {
          method: 'DELETE',
          headers: { cookie: bob },
        })
      ).status,
    ).toBe(404);

    // Bob cannot pull a Contoso user into a Fabrikam group.
    const groupB = await json<{ id: string }>(
      await request(ctx, '/api/v1/groups', {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({ name: 'Fabrikam Ops', kind: 'security' }),
      }),
    );
    const crossMember = await request(ctx, `/api/v1/groups/${groupB.id}/members`, {
      method: 'POST',
      headers: { cookie: bob },
      body: JSON.stringify({ userId: aliceId }),
    });
    expect(crossMember.status).toBe(404);

    const bobApps = await json<{ items: unknown[] }>(
      await request(ctx, '/api/v1/applications', { headers: { cookie: bob } }),
    );
    expect(bobApps.items).toHaveLength(0);
    expect(
      (
        await request(ctx, `/api/v1/applications/${appA.id}`, {
          method: 'DELETE',
          headers: { cookie: bob },
        })
      ).status,
    ).toBe(404);

    const bobAudit = await json<{ items: Array<{ action: string; resource: { id?: string } }> }>(
      await request(ctx, '/api/v1/audit?limit=200', { headers: { cookie: bob } }),
    );
    expect(
      bobAudit.items.some(
        (e) => e.action === 'directory.group.created' && e.resource.id === groupA.id,
      ),
    ).toBe(false);
    expect(
      bobAudit.items.some(
        (e) => e.action === 'directory.group.created' && e.resource.id === groupB.id,
      ),
    ).toBe(true);

    const aliceAudit = await json<{ items: Array<{ resource: { id?: string } }> }>(
      await request(ctx, '/api/v1/audit?limit=200', { headers: { cookie: alice } }),
    );
    expect(aliceAudit.items.some((e) => e.resource?.id === groupB.id)).toBe(false);

    const bobSystem = await json<{
      counts: { users: number; groups: number; applications: number };
    }>(await request(ctx, '/api/v1/system', { headers: { cookie: bob } }));
    expect(bobSystem.counts).toMatchObject({ users: 1, groups: 1, applications: 0 });
  });

  it('gives a verified domain to exactly one tenant and keeps mail addresses on it', async () => {
    const { alice, bob } = await twoTenants(ctx);

    // Both register the same hostname while pending. Whoever proves DNS first owns it.
    const pendingB = await json<{ id: string; verification: { name: string; value: string } }>(
      await request(ctx, '/api/v1/domains', {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({ hostname: 'contoso.test' }),
      }),
    );
    await addVerifiedDomain(ctx, { cookie: alice }, 'contoso.test');

    // Bob publishing his own token does not help once Contoso holds the domain.
    ctx.dns.set(pendingB.verification.name, [pendingB.verification.value]);
    const stolen = await request(ctx, `/api/v1/domains/${pendingB.id}/verify`, {
      method: 'POST',
      headers: { cookie: bob },
    });
    expect(stolen.status).toBe(409);

    const again = await request(ctx, '/api/v1/domains', {
      method: 'POST',
      headers: { cookie: bob },
      body: JSON.stringify({ hostname: 'contoso.test' }),
    });
    expect(again.status).toBe(409);

    // Bob cannot create mail on Contoso's domain, or on a domain he has not verified.
    for (const primaryAddress of ['ceo@contoso.test', 'info@fabrikam.test']) {
      const response = await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({ kind: 'shared', primaryAddress }),
      });
      expect(response.status).toBe(422);
    }

    await addVerifiedDomain(ctx, { cookie: bob }, 'fabrikam.test');
    const info = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers: { cookie: bob },
      body: JSON.stringify({ kind: 'shared', primaryAddress: 'info@fabrikam.test' }),
    });
    expect(info.status).toBe(201);
    const infoBox = await json<{ id: string }>(info);

    const crossAlias = await request(ctx, `/api/v1/mailboxes/${infoBox.id}/aliases`, {
      method: 'POST',
      headers: { cookie: bob },
      body: JSON.stringify({ alias: 'sales@contoso.test' }),
    });
    expect(crossAlias.status).toBe(422);

    const aliceBoxes = await json<{ items: unknown[] }>(
      await request(ctx, '/api/v1/mailboxes', { headers: { cookie: alice } }),
    );
    expect(aliceBoxes.items).toHaveLength(0);
    expect(
      (
        await request(ctx, `/api/v1/mailboxes/${infoBox.id}`, {
          method: 'DELETE',
          headers: { cookie: alice },
        })
      ).status,
    ).toBe(404);

    const bobDomains = await json<{ items: Array<{ hostname: string; status: string }> }>(
      await request(ctx, '/api/v1/domains', { headers: { cookie: bob } }),
    );
    expect(bobDomains.items.map((d) => `${d.hostname}:${d.status}`).sort()).toEqual([
      'contoso.test:pending',
      'fabrikam.test:verified',
    ]);
  });

  it('lets only platform operators confirm a domain without DNS', async () => {
    const { alice, bob } = await twoTenants(ctx);
    const pending = await json<{ id: string }>(
      await request(ctx, '/api/v1/domains', {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({ hostname: 'intranet.fabrikam.test' }),
      }),
    );
    const denied = await request(ctx, `/api/v1/domains/${pending.id}/confirm`, {
      method: 'POST',
      headers: { cookie: bob },
    });
    expect(denied.status).toBe(403);

    const own = await json<{ id: string }>(
      await request(ctx, '/api/v1/domains', {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ hostname: 'intranet.contoso.test' }),
      }),
    );
    const confirmed = await request(ctx, `/api/v1/domains/${own.id}/confirm`, {
      method: 'POST',
      headers: { cookie: alice },
    });
    expect(confirmed.status).toBe(200);
    expect((await json<{ status: string }>(confirmed)).status).toBe('verified');
  });

  it('scopes roles per tenant for an account that belongs to two tenants', async () => {
    const { alice, bob, tenantA, tenantB } = await twoTenants(ctx);
    const bobId = await userIdOf(ctx, bob);

    const added = await request(ctx, `/api/v1/tenants/${tenantA}/members`, {
      method: 'POST',
      headers: { cookie: alice },
      body: JSON.stringify({ email: 'bob@fabrikam.test', role: 'tenant.auditor' }),
    });
    expect(added.status).toBe(201);

    const inA = { cookie: bob, 'x-aspectenant-tenant': tenantA };
    const sessionA = await json<Session>(await request(ctx, '/api/v1/session', { headers: inA }));
    expect(sessionA.organisation?.id).toBe(tenantA);
    expect(sessionA.roles).toEqual(['tenant.auditor']);
    expect(sessionA.tenants.map((t) => t.id).sort()).toEqual([tenantA, tenantB].sort());

    // Auditor in A: can read, cannot write.
    expect((await request(ctx, '/api/v1/users', { headers: inA })).status).toBe(200);
    const write = await request(ctx, '/api/v1/groups', {
      method: 'POST',
      headers: inA,
      body: JSON.stringify({ name: 'Nope', kind: 'security' }),
    });
    expect(write.status).toBe(403);

    // Owner in B is unchanged, selected by slug.
    const inB = { cookie: bob, 'x-aspectenant-tenant': 'fabrikam' };
    const groupB = await request(ctx, '/api/v1/groups', {
      method: 'POST',
      headers: inB,
      body: JSON.stringify({ name: 'Fabrikam Only', kind: 'security' }),
    });
    expect(groupB.status).toBe(201);

    // Contoso cannot change Bob's account-wide profile or sessions because he also belongs to B.
    const profile = await request(ctx, `/api/v1/users/${bobId}`, {
      method: 'PATCH',
      headers: { cookie: alice },
      body: JSON.stringify({ displayName: 'Renamed by Contoso' }),
    });
    expect(profile.status).toBe(403);
    expect(
      (await request(ctx, `/api/v1/users/${bobId}/sessions`, { headers: { cookie: alice } }))
        .status,
    ).toBe(403);

    // Suspending Bob in Contoso removes his Contoso access only.
    const suspended = await request(ctx, `/api/v1/users/${bobId}/suspend`, {
      method: 'POST',
      headers: { cookie: alice },
      body: JSON.stringify({ reason: 'Contoso policy' }),
    });
    expect(suspended.status).toBe(200);
    expect((await json<{ status: string }>(suspended)).status).toBe('suspended');
    expect((await request(ctx, '/api/v1/users', { headers: inA })).status).toBe(403);
    expect((await request(ctx, '/api/v1/users', { headers: inB })).status).toBe(200);
    const bobAgain = await signIn(ctx, 'bob@fabrikam.test');
    const after = await json<Session>(
      await request(ctx, '/api/v1/session', { headers: { cookie: bobAgain } }),
    );
    expect(after.tenants.map((t) => t.id)).toEqual([tenantB]);
  });

  it('enforces role changes inside one tenant', async () => {
    const { alice } = await twoTenants(ctx);
    const aliceId = await userIdOf(ctx, alice);
    const created = await json<{ id: string }>(
      await request(ctx, '/api/v1/users', {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({
          email: 'carol@contoso.test',
          password: PASSWORD,
          role: 'tenant.admin',
        }),
      }),
    );
    const carol = await signIn(ctx, 'carol@contoso.test');

    // Admins cannot suspend, remove or re-role the owner, or reach platform routes.
    for (const [method, path, body] of [
      ['POST', `/api/v1/users/${aliceId}/suspend`, { reason: 'takeover' }],
      ['DELETE', `/api/v1/users/${aliceId}`, undefined],
      ['PUT', `/api/v1/users/${aliceId}/role`, { role: 'tenant.auditor' }],
    ] as const) {
      const response = await request(ctx, path, {
        method,
        headers: { cookie: carol },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(403);
    }
    expect((await request(ctx, '/api/v1/tenants', { headers: { cookie: carol } })).status).toBe(
      403,
    );

    // Owner demotes Carol to auditor; she loses write access immediately.
    const demoted = await request(ctx, `/api/v1/users/${created.id}/role`, {
      method: 'PUT',
      headers: { cookie: alice },
      body: JSON.stringify({ role: 'tenant.auditor' }),
    });
    expect(demoted.status).toBe(200);
    expect((await json<{ roles: string[] }>(demoted)).roles).toEqual(['tenant.auditor']);
    const write = await request(ctx, '/api/v1/groups', {
      method: 'POST',
      headers: { cookie: carol },
      body: JSON.stringify({ name: 'Blocked', kind: 'security' }),
    });
    expect(write.status).toBe(403);

    // Removing Carol (who belongs nowhere else) also disables her sign-in.
    const removed = await request(ctx, `/api/v1/users/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: alice },
    });
    expect(removed.status).toBe(204);
    const login = await request(ctx, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'carol@contoso.test', password: PASSWORD }),
    });
    expect(login.status).toBeGreaterThanOrEqual(400);
  });

  it('archives and restores a tenant', async () => {
    const { alice, bob, tenantB } = await twoTenants(ctx);
    const archived = await request(ctx, `/api/v1/tenants/${tenantB}/archive`, {
      method: 'POST',
      headers: { cookie: alice },
    });
    expect(archived.status).toBe(200);
    expect((await request(ctx, '/api/v1/users', { headers: { cookie: bob } })).status).toBe(403);
    const session = await json<Session>(
      await request(ctx, '/api/v1/session', { headers: { cookie: bob } }),
    );
    expect(session.organisation).toBeNull();
    expect(session.tenants).toHaveLength(0);

    const list = await json<{ items: Array<{ id: string; status: string }> }>(
      await request(ctx, '/api/v1/tenants', { headers: { cookie: alice } }),
    );
    expect(list.items.find((t) => t.id === tenantB)?.status).toBe('archived');

    const restored = await request(ctx, `/api/v1/tenants/${tenantB}/restore`, {
      method: 'POST',
      headers: { cookie: alice },
    });
    expect(restored.status).toBe(200);
    expect((await request(ctx, '/api/v1/users', { headers: { cookie: bob } })).status).toBe(200);
  });

  it('ignores identity headers supplied by the client', async () => {
    const { bob } = await twoTenants(ctx);
    const bobId = await userIdOf(ctx, bob);
    const spoofed = await request(ctx, '/api/v1/users', {
      headers: { 'x-aspectenant-account-id': bobId },
    });
    expect(spoofed.status).toBe(401);
  });
});

const message = (to: string, subject: string) =>
  [
    'From: Sender <sender@outside.test>',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${subject.replace(/\s+/g, '-')}@outside.test>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Body',
    '',
  ].join('\r\n');

describe('mail isolation between tenants', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  /** Each tenant gets a verified domain, a user mailbox for its owner and an ingest token. */
  async function mailTenants() {
    const tenants = await twoTenants(ctx);
    const setup = async (cookie: string, domain: string, owner: string) => {
      await addVerifiedDomain(ctx, { cookie }, domain);
      const userId = await userIdOf(ctx, cookie);
      const mailbox = await json<{ id: string }>(
        await request(ctx, '/api/v1/mailboxes', {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({ kind: 'user', userId, primaryAddress: `${owner}@${domain}` }),
        }),
      );
      const { token } = await json<{ token: string }>(
        await request(ctx, '/api/v1/mail/settings/ingest-token', {
          method: 'POST',
          headers: { cookie },
        }),
      );
      return { mailboxId: mailbox.id, token };
    };
    const a = await setup(tenants.alice, 'contoso.test', 'alice');
    const b = await setup(tenants.bob, 'fabrikam.test', 'bob');
    return { ...tenants, a, b };
  }

  const ingest = (token: string, to: string, subject: string) =>
    request(ctx, '/api/v1/mail/ingest', {
      method: 'POST',
      body: message(to, subject),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'message/rfc822',
        'x-envelope-to': to,
      },
    });

  it('delivers inbound mail only into the tenant that owns the ingest token', async () => {
    const { alice, bob, a, b } = await mailTenants();
    expect((await ingest(a.token, 'alice@contoso.test', 'For Alice')).status).toBe(200);
    // Contoso's token cannot drop mail into Fabrikam's mailbox.
    expect((await ingest(a.token, 'bob@fabrikam.test', 'Cross tenant')).status).toBe(404);
    expect((await ingest(b.token, 'bob@fabrikam.test', 'For Bob')).status).toBe(200);

    const subjects = async (cookie: string, mailboxId: string) =>
      (
        await json<{ items: Array<{ subject: string }> }>(
          await request(ctx, `/api/v1/mail/mailboxes/${mailboxId}/messages?folder=INBOX`, {
            headers: { cookie },
          }),
        )
      ).items.map((item) => item.subject);
    expect(await subjects(alice, a.mailboxId)).toEqual(['For Alice']);
    expect(await subjects(bob, b.mailboxId)).toEqual(['For Bob']);
  });

  it('keeps webmail messages and mailboxes private to their tenant', async () => {
    const { alice, bob, a, b } = await mailTenants();
    await ingest(a.token, 'alice@contoso.test', 'Secret');
    const aliceMessages = await json<{ items: Array<{ id: string }> }>(
      await request(ctx, `/api/v1/mail/mailboxes/${a.mailboxId}/messages?folder=INBOX`, {
        headers: { cookie: alice },
      }),
    );
    const secretId = aliceMessages.items[0]?.id ?? '';
    expect(secretId).not.toBe('');

    for (const path of [
      `/api/v1/mail/messages/${secretId}`,
      `/api/v1/mail/messages/${secretId}/raw`,
      `/api/v1/mail/mailboxes/${a.mailboxId}/messages?folder=INBOX`,
    ]) {
      const response = await request(ctx, path, { headers: { cookie: bob } });
      expect([403, 404]).toContain(response.status);
    }
    const bobBoxes = await json<{ items: Array<{ id: string }> }>(
      await request(ctx, '/api/v1/mail/me', { headers: { cookie: bob } }),
    );
    expect(bobBoxes.items.map((item) => item.id)).toEqual([b.mailboxId]);

    // Bob cannot send from Contoso's mailbox or address.
    const spoof = await request(ctx, '/api/v1/mail/send', {
      method: 'POST',
      headers: { cookie: bob },
      body: JSON.stringify({
        mailboxId: a.mailboxId,
        to: ['bob@fabrikam.test'],
        subject: 'x',
        text: 'x',
      }),
    });
    expect([403, 404]).toContain(spoof.status);
  });

  it('binds mail app logins to the tenant that owns the address', async () => {
    const { tenantA, tenantB } = await mailTenants();
    const accounts = ctx.platform.mailServers.accounts;
    expect(await accounts.verify('bob@fabrikam.test', PASSWORD, '127.0.0.1')).toMatchObject({
      tenantId: tenantB,
    });
    expect(await accounts.verify('alice@contoso.test', PASSWORD, '127.0.0.1')).toMatchObject({
      tenantId: tenantA,
    });
    expect(await accounts.verify('bob@fabrikam.test', 'wrong-password', '127.0.0.2')).toBeNull();
  });

  it('keeps installation settings away from tenant owners', async () => {
    const { alice, bob } = await mailTenants();
    const attempts: Array<[string, string, unknown]> = [
      ['GET', '/api/v1/backups', undefined],
      ['POST', '/api/v1/backups/run', undefined],
      ['POST', '/api/v1/updates/check', undefined],
      ['PUT', '/api/v1/updates/settings', { autoUpdate: false }],
      ['GET', '/api/v1/integrations/domain-connect', undefined],
      [
        'PUT',
        '/api/v1/mail/clients',
        { enabled: false, hostname: 'mail.fabrikam.test', certMode: 'manual' },
      ],
      ['PATCH', '/api/v1/settings', { name: 'Fabrikam', publicUrl: 'https://evil.test' }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await request(ctx, path, {
        method,
        headers: { cookie: bob },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 403`);
    }
    // Renaming his own organisation is still allowed.
    const rename = await request(ctx, '/api/v1/settings', {
      method: 'PATCH',
      headers: { cookie: bob },
      body: JSON.stringify({ name: 'Fabrikam Ltd' }),
    });
    expect(rename.status).toBe(200);

    // The operator can change the public URL; every tenant sees the same installation value.
    const changed = await request(ctx, '/api/v1/settings', {
      method: 'PATCH',
      headers: { cookie: alice },
      body: JSON.stringify({ name: 'Contoso', publicUrl: 'https://panel.example.test' }),
    });
    expect(changed.status).toBe(200);
    const bobView = await json<{ publicUrl: string | null }>(
      await request(ctx, '/api/v1/settings', { headers: { cookie: bob } }),
    );
    expect(bobView.publicUrl).toBe('https://panel.example.test');
  });
});

describe('upgrade from single-tenant releases', () => {
  let ctx: TestContext | undefined;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
    ctx = undefined;
  });

  it('moves global tenant roles into the default organisation and keeps the owner an operator', async () => {
    const first = await createTestContext();
    const alice = await setupOwner(first, 'alice@contoso.test', 'Contoso');
    const aliceId = await userIdOf(first, alice);
    const tenantId = (
      await json<Session>(await request(first, '/api/v1/session', { headers: { cookie: alice } }))
    ).organisation?.id;

    // Recreate the state an older release left behind: a global tenant.owner assignment.
    await first.platform.rbac.admin.revokeRole({
      subjectId: aliceId,
      roleKey: 'tenant.owner',
      scope: { orgId: tenantId ?? '' },
    });
    await first.database.query(
      `INSERT INTO rbac_assignments (id, subject_id, role_key, org_id, team_id, created_at)
       VALUES ('legacy-owner', $1, 'tenant.owner', '', '', $2)`,
      [aliceId, Date.now()],
    );

    ctx = await createTestContext({ database: first.database });
    const assignments = await ctx.platform.rbac.admin.listAssignments({ subjectId: aliceId });
    const keys = assignments.items.map((a) => `${a.roleKey}@${a.orgId ?? 'global'}`).sort();
    expect(keys).toEqual([`platform.operator@global`, `tenant.owner@${tenantId}`].sort());

    const cookie = await signIn(ctx, 'alice@contoso.test');
    expect((await request(ctx, '/api/v1/users', { headers: { cookie } })).status).toBe(200);
  });
});
