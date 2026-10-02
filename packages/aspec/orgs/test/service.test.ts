import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgsError } from '../src/errors.js';
import { createOrgs } from '../src/service.js';
import { currentTenant } from '../src/tenant.js';
import { allBackends } from './helpers/backends.js';
import { createFakeAudit, createFakeMailer } from './helpers/fakes.js';

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OrgsError && e.code === code);
}

for (const backend of allBackends()) {
  describe.skipIf(backend.skip)(`OrgsService on ${backend.name}`, () => {
    beforeAll(async () => {
      await backend.init();
    });
    afterAll(async () => {
      await backend.close();
    });

    it('creates org with creator as owner', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Acme', createdBy: 'u1' });
      expect(org.slug).toBe('acme');
      const m = await orgs.getMembership(org.id, 'u1');
      expect(m?.role).toBe('owner');
      expect(m?.status).toBe('active');
    });

    it('rejects duplicate slug', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      await orgs.createOrg({ name: 'Acme', slug: 'acme', createdBy: 'u1' });
      await expectCode(
        orgs.createOrg({ name: 'Other', slug: 'acme', createdBy: 'u2' }),
        'ORGS_SLUG_TAKEN',
      );
    });

    it('protects last owner', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Solo', createdBy: 'u1' });
      await expectCode(orgs.removeMember(org.id, 'u1'), 'ORGS_LAST_OWNER');
      await expectCode(orgs.changeMemberRole(org.id, 'u1', 'admin'), 'ORGS_LAST_OWNER');
    });

    it('transfers ownership', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Co', createdBy: 'u1' });
      await orgs.addMember(org.id, 'u2', 'admin');
      const { previous, next } = await orgs.transferOwnership(org.id, 'u1', 'u2');
      expect(previous.role).toBe('admin');
      expect(next.role).toBe('owner');
    });

    it('manages teams requiring org membership', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Teams Co', createdBy: 'u1' });
      const team = await orgs.createTeam(org.id, { name: 'Core' });
      await expectCode(orgs.addTeamMember(team.id, 'stranger'), 'ORGS_NOT_ORG_MEMBER');
      await orgs.addMember(org.id, 'u2');
      const tm = await orgs.addTeamMember(team.id, 'u2', 'maintainer');
      expect(tm.role).toBe('maintainer');
    });

    it('invites and accepts with mailer', async () => {
      const mailer = createFakeMailer();
      const audit = createFakeAudit();
      const now = 1_000_000;
      const orgs = createOrgs({
        mode: 'multi',
        store: await backend.fresh(),
        mailer,
        audit,
        clock: { now: () => now },
        invitations: { acceptUrl: 'https://app.test/accept?token={token}', appName: 'Test' },
      });
      const org = await orgs.createOrg({ name: 'Invite Co', createdBy: 'u1' });
      const result = await orgs.invite({ orgId: org.id, email: 'Bob@Example.COM', role: 'member' });
      expect(result.delivery).toBe('sent');
      expect(result.token).toBeUndefined();
      expect(mailer.sent[0]?.category).toBe('orgs.invitation');
      expect(mailer.sent[0]?.to).toBe('bob@example.com');

      const token = /token=([^&\s]+)/.exec(mailer.sent[0]!.text)?.[1];
      expect(token).toBeTruthy();
      const decoded = decodeURIComponent(token!);
      const accepted = await orgs.acceptInvitation(decoded, {
        userId: 'u2',
        email: 'bob@example.com',
      });
      expect(accepted.created).toBe(true);
      expect(accepted.membership.status).toBe('active');
      expect(audit.events.some((e) => e.action === 'orgs.invitation.accepted')).toBe(true);

      // idempotent re-accept
      const again = await orgs.acceptInvitation(decoded, {
        userId: 'u2',
        email: 'bob@example.com',
      });
      expect(again.created).toBe(false);
    });

    it('rejects duplicate pending invitation', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Dup', createdBy: 'u1' });
      await orgs.invite({ orgId: org.id, email: 'x@example.com' });
      await expectCode(
        orgs.invite({ orgId: org.id, email: 'x@example.com' }),
        'ORGS_INVITATION_EXISTS',
      );
    });

    it('returns token without mailer and throttles resend', async () => {
      let now = 5_000_000;
      const orgs = createOrgs({
        mode: 'multi',
        store: await backend.fresh(),
        clock: { now: () => now },
        invitations: { resendIntervalMs: 60_000 },
      });
      const org = await orgs.createOrg({ name: 'Manual', createdBy: 'u1' });
      const first = await orgs.invite({ orgId: org.id, email: 'a@example.com' });
      expect(first.delivery).toBe('manual');
      expect(first.token).toBeTruthy();
      await expectCode(orgs.resendInvitation(first.invitation.id), 'ORGS_INVITATION_THROTTLED');
      now += 61_000;
      const resent = await orgs.resendInvitation(first.invitation.id);
      expect(resent.token).toBeTruthy();
    });

    it('rejects expired invitation', async () => {
      let now = 10_000_000;
      const orgs = createOrgs({
        mode: 'multi',
        store: await backend.fresh(),
        clock: { now: () => now },
        invitations: { ttlMs: 1000 },
      });
      const org = await orgs.createOrg({ name: 'Exp', createdBy: 'u1' });
      const inv = await orgs.invite({ orgId: org.id, email: 'e@example.com' });
      now += 2000;
      await expectCode(
        orgs.acceptInvitation(inv.token!, { userId: 'u9', email: 'e@example.com' }),
        'ORGS_INVITATION_EXPIRED',
      );
    });

    it('enforces optimistic concurrency on org update', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Ver', createdBy: 'u1' });
      await orgs.updateOrg(org.id, { name: 'Ver 2' });
      await expectCode(
        orgs.updateOrg(org.id, { name: 'Ver 3' }, { expectedVersion: org.version }),
        'ORGS_VERSION_CONFLICT',
      );
    });

    it('single mode has implicit default org', async () => {
      const orgs = createOrgs({ mode: 'single', store: await backend.fresh() });
      const org = await orgs.getDefaultOrg();
      expect(org.id).toBe('default');
      await expectCode(orgs.createOrg({ name: 'Nope', createdBy: 'u1' }), 'ORGS_INVALID_STATE');
    });

    it('provisions shared tenant and enters context', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Tenant Co', slug: 'tenant-co', createdBy: 'u1' });
      const tenant = await orgs.provisionTenant(org.id);
      expect(tenant.strategy).toBe('shared');
      const seen = (await orgs.enterTenant({ slug: 'tenant-co', userId: 'u1' }, () =>
        currentTenant(),
      )) as ReturnType<typeof currentTenant>;
      expect(seen?.orgId).toBe(org.id);
      expect(seen?.roles).toContain('owner');
      await expectCode(
        orgs.enterTenant({ slug: 'tenant-co', userId: 'outsider' }, () => null),
        'ORGS_TENANT_FORBIDDEN',
      );
    });

    it('checks org-scoped permissions from role map', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Perms', createdBy: 'u1' });
      await orgs.addMember(org.id, 'u2', 'member');
      expect(await orgs.can('u1', org.id, 'orgs:invite')).toBe(true);
      expect(await orgs.can('u2', org.id, 'orgs:invite')).toBe(false);
      expect(await orgs.can('u2', org.id, 'orgs:read')).toBe(true);
    });

    it('archives before delete', async () => {
      const orgs = createOrgs({ mode: 'multi', store: await backend.fresh() });
      const org = await orgs.createOrg({ name: 'Del', createdBy: 'u1' });
      await expectCode(orgs.deleteOrg(org.id), 'ORGS_INVALID_STATE');
      await orgs.archiveOrg(org.id);
      const deleted = await orgs.deleteOrg(org.id);
      expect(deleted.status).toBe('deleted');
    });
  });
}
