import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UsersError } from '../src/errors.js';
import type { StandardSchemaV1 } from '../src/fields.js';
import { createMaintenanceJobHandler, createPurgeJobHandler } from '../src/jobs.js';
import { createUsers, type UsersOptions, type UsersService } from '../src/service.js';
import type { UsersStore } from '../src/store.js';
import { allBackends } from './helpers/backends.js';
import {
  FakeAudit,
  FakeClock,
  FakeJobs,
  FakeMailer,
  FakePermissions,
  MemoryLogger,
  sequentialIds,
} from './helpers/fakes.js';

const DAY = 86_400_000;

async function expectCode(p: Promise<unknown>, code: string): Promise<UsersError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(UsersError);
    expect((err as UsersError).code).toBe(code);
    return err as UsersError;
  }
  throw new Error(`expected ${code}`);
}

const nicknameSchema: StandardSchemaV1<string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (typeof value === 'string' && /^[a-z]{3,12}$/.test(value)) return { value };
      return { issues: [{ message: 'must be 3 to 12 lowercase letters' }] };
    },
  },
};

for (const backend of allBackends()) {
  describe.skipIf(backend.skip)(`UsersService on ${backend.name}`, () => {
    let store: UsersStore;
    let clock: FakeClock;
    let audit: FakeAudit;
    let mailer: FakeMailer;
    let jobs: FakeJobs;
    let logger: MemoryLogger;
    let users: UsersService;

    const build = (extra: Partial<UsersOptions> = {}) =>
      createUsers({
        store,
        clock,
        audit,
        logger,
        jobs,
        generateId: sequentialIds(),
        profileFields: {
          company: { type: 'string', maxLength: 50 },
          nickname: { schema: nicknameSchema },
          verifiedBadge: { type: 'boolean', userEditable: false },
        },
        settings: {
          mfaRequired: { type: 'boolean', default: false },
          marketingEmails: { type: 'boolean', default: true, userEditable: true },
        },
        preferences: {
          theme: { type: 'string', enum: ['light', 'dark', 'system'], default: 'system' },
          pageSize: { type: 'integer', min: 10, max: 100, default: 25 },
          locked: { type: 'string', userEditable: false },
        },
        ...extra,
      });

    beforeAll(async () => {
      await backend.init();
    });
    afterAll(async () => {
      await backend.close();
    });
    beforeEach(async () => {
      store = await backend.fresh();
      clock = new FakeClock();
      audit = new FakeAudit();
      mailer = new FakeMailer();
      jobs = new FakeJobs();
      logger = new MemoryLogger();
      users = build();
    });

    describe('creation and profiles', () => {
      it('creates a user with a normalised email, supplied ID and external identity', async () => {
        const user = await users.createUser(
          {
            id: 'auth|123',
            email: '  Ada@Example.COM ',
            externalId: 'sub-123',
            authProvider: 'aspec-auth',
            profile: { displayName: 'Ada', locale: 'en-gb', timezone: 'Europe/London' },
          },
          { actor: { id: 'admin-1' } },
        );
        expect(user).toMatchObject({
          id: 'auth|123',
          email: 'ada@example.com',
          status: 'active',
          externalId: 'sub-123',
          authProvider: 'aspec-auth',
          version: 1,
          activatedAt: clock.now(),
        });
        expect(user.profile.locale).toBe('en-GB');
        expect(user.profile.timezone).toBe('Europe/London');
        expect(await users.findUserByEmail('ADA@example.com')).toMatchObject({ id: 'auth|123' });
        expect(await users.findUserByExternalId('aspec-auth', 'sub-123')).toMatchObject({
          id: 'auth|123',
        });
        expect(audit.events[0]).toMatchObject({
          action: 'users.created',
          actor: { id: 'admin-1' },
          resource: { type: 'user', id: 'auth|123' },
        });
        const activity = await users.listActivity('auth|123');
        expect(activity.items.map((e) => e.type)).toEqual(['created']);
      });

      it('rejects duplicate emails regardless of case', async () => {
        await users.createUser({ email: 'dup@example.com' });
        await expectCode(users.createUser({ email: 'DUP@example.com' }), 'USERS_EMAIL_TAKEN');
      });

      it('validates profile fields including custom Standard Schema fields', async () => {
        const err = await expectCode(
          users.createUser({
            email: 'x@example.com',
            profile: {
              avatarUrl: 'http://insecure.example.com/a.png',
              locale: 'not a locale!',
              timezone: 'Mars/Olympus',
              fields: { nickname: 'NO', unknownField: 1 },
            },
          }),
          'USERS_VALIDATION_FAILED',
        );
        const paths = (err.details as { issues: Array<{ path: string }> }).issues.map(
          (i) => i.path,
        );
        expect(paths).toEqual(
          expect.arrayContaining([
            'profile.avatarUrl',
            'profile.locale',
            'profile.timezone',
            'profile.fields.nickname',
            'profile.fields.unknownField',
          ]),
        );
        await expectCode(
          users.createUser({
            email: 'y@example.com',
            profile: { avatarUrl: 'https://u:p@example.com/a.png' },
          }),
          'USERS_VALIDATION_FAILED',
        );
        await expectCode(users.createUser({ email: 'not-an-email' }), 'USERS_VALIDATION_FAILED');
        await expectCode(
          users.createUser({ id: 'bad id', email: 'z@example.com' }),
          'USERS_VALIDATION_FAILED',
        );
      });

      it('updates profiles with optimistic concurrency and records changes', async () => {
        const u = await users.createUser({ email: 'p@example.com' });
        const updated = await users.updateProfile(
          u.id,
          {
            displayName: 'Pat',
            avatarUrl: 'https://cdn.example.com/p.png',
            fields: { nickname: 'patty', company: 'ACME' },
          },
          { expectedVersion: 1 },
          { actor: { id: u.id } },
        );
        expect(updated.version).toBe(2);
        expect(updated.profile).toMatchObject({
          displayName: 'Pat',
          fields: { nickname: 'patty', company: 'ACME' },
        });
        const conflict = await expectCode(
          users.updateProfile(u.id, { displayName: 'Stale' }, { expectedVersion: 1 }),
          'USERS_VERSION_CONFLICT',
        );
        expect(conflict.details).toEqual({ currentVersion: 2 });
        const cleared = await users.updateProfile(u.id, {
          fields: { company: null },
          bio: 'Line one\nLine two',
        });
        expect(cleared.profile.fields).toEqual({ nickname: 'patty' });
        expect(cleared.profile.bio).toBe('Line one\nLine two');
        const ev = audit.events.find((e) => e.action === 'users.profile.updated');
        expect(ev?.changes).toEqual({
          before: { displayName: null, avatarUrl: null, fields: {} },
          after: {
            displayName: 'Pat',
            avatarUrl: 'https://cdn.example.com/p.png',
            fields: { nickname: 'patty', company: 'ACME' },
          },
        });
        expect((await users.listActivity(u.id, { type: 'profile.updated' })).items).toHaveLength(2);
      });

      it('enforces userEditable for self-service updates', async () => {
        const u = await users.createUser({ email: 's@example.com' });
        await expectCode(
          users.updateProfile(u.id, { fields: { verifiedBadge: true } }, { selfService: true }),
          'USERS_VALIDATION_FAILED',
        );
        const admin = await users.updateProfile(u.id, { fields: { verifiedBadge: true } });
        expect(admin.profile.fields.verifiedBadge).toBe(true);
        await expectCode(
          users.updateSettings(u.id, { mfaRequired: true }, { selfService: true }),
          'USERS_VALIDATION_FAILED',
        );
        await users.updateSettings(u.id, { marketingEmails: false }, { selfService: true });
        await expectCode(
          users.updatePreferences(u.id, { locked: 'x' }, { selfService: true }),
          'USERS_VALIDATION_FAILED',
        );
      });

      it('changes email, links identities and updates metadata', async () => {
        const u = await users.createUser({ email: 'old@example.com' });
        await users.createUser({ email: 'taken@example.com' });
        await expectCode(users.changeEmail(u.id, 'TAKEN@example.com'), 'USERS_EMAIL_TAKEN');
        const changed = await users.changeEmail(u.id, 'New@Example.com');
        expect(changed.email).toBe('new@example.com');
        const linked = await users.linkIdentity(u.id, { authProvider: 'okta', externalId: '00u1' });
        expect(linked).toMatchObject({ authProvider: 'okta', externalId: '00u1' });
        const unlinked = await users.linkIdentity(u.id, null);
        expect(unlinked.externalId).toBeNull();
        const meta = await users.updateMetadata(u.id, { plan: 'pro' });
        expect(meta.metadata).toEqual({ plan: 'pro' });
        expect(audit.actions()).toEqual(
          expect.arrayContaining([
            'users.email.changed',
            'users.identity.linked',
            'users.identity.unlinked',
            'users.metadata.updated',
          ]),
        );
      });

      it('lists users with filters and cursor pagination', async () => {
        for (let i = 0; i < 5; i++) {
          await users.createUser({
            email: `list${i}@example.com`,
            status: i === 4 ? 'pending' : 'active',
          });
          clock.advance(1);
        }
        const p1 = await users.listUsers({ limit: 3 });
        expect(p1.items).toHaveLength(3);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await users.listUsers({ limit: 3, cursor: p1.nextCursor as string });
        expect(p2.items.map((u) => u.email)).toEqual(['list3@example.com', 'list4@example.com']);
        expect(p2.nextCursor).toBeNull();
        expect((await users.listUsers({ status: 'pending' })).items).toHaveLength(1);
        expect((await users.listUsers({ search: 'LIST2' })).items).toHaveLength(1);
        await expectCode(users.listUsers({ cursor: 'garbage!' }), 'USERS_INVALID_CURSOR');
      });
    });

    describe('settings and preferences', () => {
      it('merges defaults with per-user overrides and resets with null', async () => {
        const u = await users.createUser({ email: 'pref@example.com' });
        expect(await users.getPreferences(u.id)).toEqual({ theme: 'system', pageSize: 25 });
        await users.updatePreferences(u.id, { theme: 'dark', pageSize: 50 });
        expect(await users.getPreferences(u.id)).toEqual({ theme: 'dark', pageSize: 50 });
        await users.updatePreferences(u.id, { theme: null });
        expect(await users.getPreferences(u.id)).toEqual({ theme: 'system', pageSize: 50 });
        await expectCode(users.updatePreferences(u.id, { pageSize: 5 }), 'USERS_VALIDATION_FAILED');
        await expectCode(
          users.updatePreferences(u.id, { theme: 'neon' }),
          'USERS_VALIDATION_FAILED',
        );
        await expectCode(
          users.updatePreferences(u.id, { undefinedKey: 1 }),
          'USERS_VALIDATION_FAILED',
        );
        expect(await users.getSettings(u.id)).toEqual({
          mfaRequired: false,
          marketingEmails: true,
        });
        await users.updateSettings(u.id, { mfaRequired: true });
        expect((await users.getSettings(u.id)).mfaRequired).toBe(true);
        const ev = audit.events.find((e) => e.action === 'users.preferences.updated');
        expect(ev?.changes).toEqual({
          before: { theme: null, pageSize: null },
          after: { theme: 'dark', pageSize: 50 },
        });
      });

      it('rejects invalid definitions at construction', () => {
        expect(() => build({ preferences: { x: { type: 'string', pattern: '(' } } })).toThrow(
          /pattern/,
        );
        expect(() => build({ preferences: { x: { type: 'integer', default: 1.5 } } })).toThrow(
          /default/,
        );
        expect(() => build({ settings: { 'bad key!': { type: 'boolean' } } })).toThrow(
          /invalid field key/,
        );
        expect(() => build({ profileFields: { x: { schema: {} as StandardSchemaV1 } } })).toThrow(
          /Standard Schema/,
        );
      });
    });

    describe('suspension and activation', () => {
      it('suspends with reason and until, then reinstates automatically when expired', async () => {
        const u = await users.createUser({ email: 'sus@example.com' });
        const suspended = await users.suspendUser(
          u.id,
          { reason: 'Chargeback', until: clock.now() + DAY },
          { actor: { id: 'admin-1' } },
        );
        expect(suspended.status).toBe('suspended');
        expect(suspended.suspension).toMatchObject({
          reason: 'Chargeback',
          actorId: 'admin-1',
          until: clock.now() + DAY,
        });
        expect(await users.canSignIn(u.id)).toBe(false);
        await expectCode(users.suspendUser(u.id, { reason: 'again' }), 'USERS_INVALID_STATE');
        clock.advance(DAY + 1);
        const reinstated = await users.getUser(u.id);
        expect(reinstated.status).toBe('active');
        expect(reinstated.suspension).toBeNull();
        expect(await users.canSignIn(u.id)).toBe(true);
        expect(audit.actions()).toEqual(
          expect.arrayContaining(['users.suspended', 'users.reactivated']),
        );
        const statusEvents = (await users.listActivity(u.id, { type: 'status.changed' })).items;
        expect(statusEvents.map((e) => e.metadata.to)).toEqual(['active', 'suspended']);
      });

      it('reinstates expired suspensions in bulk and supports manual reactivation', async () => {
        const a = await users.createUser({ email: 'a@example.com' });
        const b = await users.createUser({ email: 'b@example.com' });
        const c = await users.createUser({ email: 'c@example.com', status: 'pending' });
        await users.suspendUser(a.id, { reason: 'x', until: new Date(clock.now() + 1000) });
        await users.suspendUser(b.id, { reason: 'x' });
        await users.suspendUser(c.id, { reason: 'x', until: clock.now() + 1000 });
        clock.advance(2000);
        expect(await users.reinstateExpiredSuspensions()).toBe(2);
        expect((await users.getUser(c.id)).status).toBe('pending');
        expect((await users.getUser(b.id)).status).toBe('suspended');
        expect((await users.reactivateUser(b.id)).status).toBe('active');
        await expectCode(users.reactivateUser(b.id), 'USERS_INVALID_STATE');
        await expectCode(users.suspendUser(a.id, { reason: '' }), 'USERS_VALIDATION_FAILED');
        await expectCode(
          users.suspendUser(a.id, { reason: 'x', until: clock.now() - 1 }),
          'USERS_VALIDATION_FAILED',
        );
      });

      it('activates with a single-use hashed token', async () => {
        const u = await users.createUser({ email: 'act@example.com', status: 'pending' });
        expect(await users.canSignIn(u.id)).toBe(false);
        const { token, expiresAt } = await users.createActivationToken(u.id);
        expect(token).toMatch(/^act_/);
        expect(expiresAt).toBe(clock.now() + 3 * DAY);
        const stored = await store.listActivationTokens(u.id);
        expect(stored[0]?.tokenHash).not.toContain(token);
        await expectCode(users.activateWithToken(`${token}x`), 'USERS_TOKEN_INVALID');
        const active = await users.activateWithToken(token);
        expect(active.status).toBe('active');
        await expectCode(users.activateWithToken(token), 'USERS_TOKEN_INVALID');
        await expectCode(users.createActivationToken(u.id), 'USERS_INVALID_STATE');
        expect(JSON.stringify(audit.events)).not.toContain(token);
      });

      it('rejects expired activation tokens and supports admin activation', async () => {
        const u = await users.createUser({ email: 'exp@example.com', status: 'pending' });
        const { token } = await users.createActivationToken(u.id);
        clock.advance(3 * DAY + 1);
        await expectCode(users.activateWithToken(token), 'USERS_TOKEN_EXPIRED');
        const second = await users.createActivationToken(u.id);
        const activated = await users.activateUser(u.id, { actor: { id: 'admin' } });
        expect(activated.status).toBe('active');
        await expectCode(users.activateWithToken(second.token), 'USERS_TOKEN_INVALID');
        await expectCode(users.activateUser(u.id), 'USERS_INVALID_STATE');
        await expectCode(users.activateWithToken('garbage'), 'USERS_TOKEN_INVALID');
      });
    });

    describe('invitations', () => {
      it('returns the token for manual delivery when no mailer is configured', async () => {
        const result = await users.inviteUser({
          email: 'New@Example.com',
          roles: ['editor'],
          metadata: { team: 't1' },
        });
        expect(result.delivery).toBe('manual');
        expect(result.token).toMatch(/^inv_/);
        expect(result.invitation).toMatchObject({
          email: 'new@example.com',
          roles: ['editor'],
          status: 'pending',
        });
        expect(result.invitation).not.toHaveProperty('tokenHash');
        const accepted = await users.acceptInvitation(result.token as string, {
          userId: 'auth-42',
          profile: { displayName: 'Newbie' },
        });
        expect(accepted.created).toBe(true);
        expect(accepted.user).toMatchObject({
          id: 'auth-42',
          email: 'new@example.com',
          status: 'active',
          metadata: {
            invitation: { id: result.invitation.id, roles: ['editor'], metadata: { team: 't1' } },
          },
        });
        expect(accepted.invitation.status).toBe('accepted');
        const again = await users.acceptInvitation(result.token as string);
        expect(again.created).toBe(false);
        expect(again.user.id).toBe('auth-42');
        expect(audit.actions()).toEqual(
          expect.arrayContaining(['users.invitation.created', 'users.invitation.accepted']),
        );
        expect(JSON.stringify(audit.events)).not.toContain(result.token as string);
      });

      it('sends invitation emails through the Mailer port', async () => {
        users = build({
          mailer,
          invitations: {
            acceptUrl: 'https://app.example.com/invite?token={token}',
            appName: 'Acme',
          },
        });
        const result = await users.inviteUser({ email: 'mail@example.com' });
        expect(result.delivery).toBe('sent');
        expect(result.token).toBeUndefined();
        expect(mailer.sent).toHaveLength(1);
        expect(mailer.sent[0]).toMatchObject({
          to: 'mail@example.com',
          category: 'users.invitation',
          subject: 'You have been invited to Acme',
          metadata: { invitationId: result.invitation.id },
        });
        expect(mailer.sent[0]?.html).toContain('https://app.example.com/invite?token=');
        const token = mailer.lastToken();
        const accepted = await users.acceptInvitation(token);
        expect(accepted.user.email).toBe('mail@example.com');
      });

      it('supports a custom email renderer and reports mailer failures', async () => {
        users = build({
          mailer,
          logger,
          invitations: {
            renderEmail: (ctx) => ({
              subject: `Join ${ctx.appName}`,
              text: `code token=${encodeURIComponent(ctx.token)}`,
            }),
          },
        });
        mailer.failNext = true;
        const failed = await users.inviteUser({ email: 'fail@example.com' });
        expect(failed.delivery).toBe('failed');
        expect(failed.token).toBeUndefined();
        expect(
          logger.entries.some(
            (e) => e.level === 'error' && e.msg === 'users invitation email failed',
          ),
        ).toBe(true);
        clock.advance(61_000);
        const resent = await users.resendInvitation(failed.invitation.id);
        expect(resent.delivery).toBe('sent');
        expect(mailer.sent[0]?.subject).toBe('Join our application');
      });

      it('requires acceptUrl or renderEmail when a mailer is configured', () => {
        expect(() => build({ mailer })).toThrow(/acceptUrl/);
        expect(() => build({ invitations: { acceptUrl: 'ftp://x' } })).toThrow(/http/);
      });

      it('throttles resends, rotates tokens and enforces max sends', async () => {
        users = build({
          mailer,
          invitations: { acceptUrl: 'https://app.example.com/accept', maxSends: 3 },
        });
        const { invitation } = await users.inviteUser({ email: 'r@example.com' });
        const firstToken = mailer.lastToken();
        const throttled = await expectCode(
          users.resendInvitation(invitation.id),
          'USERS_INVITATION_THROTTLED',
        );
        expect(throttled.details).toMatchObject({ reason: 'interval', retryAfterMs: 60_000 });
        clock.advance(60_000);
        const resent = await users.resendInvitation(invitation.id);
        expect(resent.invitation.sendCount).toBe(2);
        await expectCode(users.acceptInvitation(firstToken), 'USERS_TOKEN_INVALID');
        clock.advance(60_000);
        await users.resendInvitation(invitation.id);
        clock.advance(60_000);
        const max = await expectCode(
          users.resendInvitation(invitation.id),
          'USERS_INVITATION_THROTTLED',
        );
        expect(max.details).toMatchObject({ reason: 'max_sends' });
        const accepted = await users.acceptInvitation(mailer.lastToken());
        expect(accepted.created).toBe(true);
      });

      it('handles duplicates, expiry, revocation and listing', async () => {
        const first = await users.inviteUser({ email: 'dupe@example.com' });
        await expectCode(
          users.inviteUser({ email: 'DUPE@example.com' }),
          'USERS_INVITATION_EXISTS',
        );
        clock.advance(7 * DAY + 1);
        expect((await users.getInvitation(first.invitation.id)).status).toBe('expired');
        await expectCode(users.acceptInvitation(first.token as string), 'USERS_INVITATION_EXPIRED');
        const second = await users.inviteUser({ email: 'dupe@example.com' });
        expect((await users.listInvitations({ status: 'pending' })).items.map((i) => i.id)).toEqual(
          [second.invitation.id],
        );
        expect((await users.listInvitations({ status: 'expired' })).items.map((i) => i.id)).toEqual(
          [first.invitation.id],
        );
        const revoked = await users.revokeInvitation(second.invitation.id, {
          actor: { id: 'admin' },
        });
        expect(revoked.status).toBe('revoked');
        expect((await users.revokeInvitation(second.invitation.id)).status).toBe('revoked');
        await expectCode(
          users.acceptInvitation(second.token as string),
          'USERS_INVITATION_REVOKED',
        );
        await expectCode(users.resendInvitation(second.invitation.id), 'USERS_INVALID_STATE');
        await expectCode(users.getInvitation('nope'), 'USERS_INVITATION_NOT_FOUND');
        expect((await users.listInvitations({ email: 'dupe@example.com' })).items).toHaveLength(2);
      });

      it('activates a pending user on acceptance and rejects invites for active accounts', async () => {
        const pending = await users.createUser({ email: 'pend@example.com', status: 'pending' });
        await users.createUser({ email: 'active@example.com' });
        await expectCode(users.inviteUser({ email: 'active@example.com' }), 'USERS_ALREADY_ACTIVE');
        const { token } = await users.inviteUser({ email: 'pend@example.com', roles: ['viewer'] });
        const result = await users.acceptInvitation(token as string, { userId: 'ignored' });
        expect(result.created).toBe(false);
        expect(result.user).toMatchObject({ id: pending.id, status: 'active' });
        expect(result.user.metadata.invitation).toMatchObject({ roles: ['viewer'] });
      });

      it('refuses acceptance for suspended accounts', async () => {
        const u = await users.createUser({ email: 'blocked@example.com', status: 'pending' });
        const { token } = await users.inviteUser({ email: 'blocked@example.com' });
        await users.suspendUser(u.id, { reason: 'fraud' });
        await expectCode(users.acceptInvitation(token as string), 'USERS_SUSPENDED');
      });

      it('emits the invitation.accepted hook', async () => {
        const seen: string[] = [];
        users.on('invitation.accepted', (e) => {
          seen.push(`${e.user.email}:${e.created}`);
        });
        const { token } = await users.inviteUser({ email: 'hook@example.com' });
        await users.acceptInvitation(token as string);
        expect(seen).toEqual(['hook@example.com:true']);
      });

      it('validates invitation input', async () => {
        await expectCode(
          users.inviteUser({ email: 'x@example.com', roles: ['bad role'] }),
          'USERS_VALIDATION_FAILED',
        );
        await expectCode(users.inviteUser({ email: 'nope' }), 'USERS_VALIDATION_FAILED');
      });
    });

    describe('deletion workflow', () => {
      it('soft deletes with a grace period, schedules a purge job and can be cancelled', async () => {
        const u = await users.createUser({ email: 'del@example.com' });
        await users.suspendUser(u.id, { reason: 'x' });
        const deleted = await users.requestDeletion(
          u.id,
          { reason: 'Leaving' },
          { actor: { id: u.id } },
        );
        expect(deleted.status).toBe('deleted');
        expect(deleted.deletion).toMatchObject({
          purgeAfter: clock.now() + 30 * DAY,
          previousStatus: 'suspended',
          reason: 'Leaving',
        });
        expect(jobs.jobs[0]).toMatchObject({ name: 'users.purge', payload: { userId: u.id } });
        expect(jobs.jobs[0]?.options?.runAt?.getTime()).toBe(clock.now() + 30 * DAY);
        await expectCode(users.requestDeletion(u.id), 'USERS_INVALID_STATE');
        await expectCode(users.updateProfile(u.id, { displayName: 'x' }), 'USERS_INVALID_STATE');
        await expectCode(users.purgeUser(u.id), 'USERS_INVALID_STATE');
        const restored = await users.cancelDeletion(u.id);
        expect(restored.status).toBe('suspended');
        expect(restored.deletion).toBeNull();
        await expectCode(users.cancelDeletion(u.id), 'USERS_INVALID_STATE');
        expect(audit.actions()).toEqual(
          expect.arrayContaining(['users.deletion.requested', 'users.deletion.cancelled']),
        );
      });

      it('anonymises on purge, runs hooks and removes personal data', async () => {
        const purging: string[] = [];
        const purged: string[] = [];
        users = build({
          hooks: {
            'user.purging': (e) => {
              purging.push(e.user.email);
            },
            'user.purged': (e) => {
              purged.push(`${e.userId}:${e.policy}`);
            },
          },
        });
        const u = await users.createUser({
          email: 'gone@example.com',
          externalId: 'x1',
          authProvider: 'okta',
          profile: { displayName: 'Gone', fields: { company: 'ACME' } },
        });
        await users.recordLogin(u.id, { ip: '10.0.0.1' });
        await users.inviteUser({ email: 'other@example.com' });
        await users.requestDeletion(u.id);
        clock.advance(30 * DAY + 1);
        const result = await users.purgeExpired();
        expect(result).toEqual({ purged: [u.id], failed: [] });
        const after = await users.getUser(u.id);
        expect(after.email).toMatch(/^deleted-[0-9a-f]{32}@users\.invalid$/);
        expect(after.profile).toEqual({
          displayName: null,
          avatarUrl: null,
          locale: null,
          timezone: null,
          bio: null,
          fields: {},
        });
        expect(after.externalId).toBeNull();
        expect(after.purgedAt).toBe(clock.now());
        expect((await users.listActivity(u.id)).items).toEqual([]);
        expect(await users.findUserByEmail('gone@example.com')).toBeNull();
        expect(purging).toEqual(['gone@example.com']);
        expect(purged).toEqual([`${u.id}:anonymise`]);
        expect(await users.purgeUser(u.id)).toEqual({ purged: false, policy: 'anonymise' });
        await users.createUser({ email: 'gone@example.com' });
        expect(audit.actions()).toContain('users.purged');
      });

      it('hard deletes when configured and aborts the purge when a hook fails', async () => {
        let fail = true;
        users = build({
          deletion: { policy: 'hard-delete', gracePeriodMs: DAY },
          hooks: {
            'user.purging': () => {
              if (fail) throw new Error('app cleanup failed');
            },
          },
        });
        const u = await users.createUser({ email: 'hard@example.com' });
        await users.requestDeletion(u.id);
        clock.advance(DAY);
        expect(await users.purgeExpired()).toEqual({ purged: [], failed: [u.id] });
        expect(await users.findUser(u.id)).not.toBeNull();
        fail = false;
        const handler = createPurgeJobHandler(users);
        await handler({ userId: u.id }, { signal: new AbortController().signal, attempt: 2 });
        expect(await users.findUser(u.id)).toBeNull();
        await handler({ userId: u.id }, { signal: new AbortController().signal, attempt: 3 });
        expect(await users.purgeUser(u.id)).toEqual({ purged: false, policy: 'hard-delete' });
      });

      it('purge job handler skips cancelled deletions and supports force purge', async () => {
        const u = await users.createUser({ email: 'job@example.com' });
        await users.requestDeletion(u.id);
        await users.cancelDeletion(u.id);
        await createPurgeJobHandler(users)(
          { userId: u.id },
          { signal: new AbortController().signal, attempt: 1 },
        );
        expect((await users.getUser(u.id)).status).toBe('active');
        await users.requestDeletion(u.id, { gracePeriodMs: DAY });
        await expectCode(
          createPurgeJobHandler(users)(
            { userId: u.id },
            { signal: new AbortController().signal, attempt: 1 },
          ),
          'USERS_INVALID_STATE',
        );
        expect(await users.purgeUser(u.id, { force: true })).toEqual({
          purged: true,
          policy: 'anonymise',
        });
        await createPurgeJobHandler(users)(
          {},
          { signal: new AbortController().signal, attempt: 1 },
        );
      });

      it('exports all module-held data without secrets', async () => {
        const u = await users.createUser({
          email: 'export@example.com',
          status: 'pending',
          preferences: { theme: 'dark' },
        });
        const { token } = await users.createActivationToken(u.id);
        await users.inviteUser({ email: 'export@example.com' });
        await users.recordActivity(u.id, { type: 'app.custom', metadata: { a: 1 } });
        const data = await users.exportUserData(u.id, { actor: { id: 'admin' } });
        expect(data.format).toBe('aspec.users.export');
        expect(data.user.id).toBe(u.id);
        expect(data.effectivePreferences).toEqual({ theme: 'dark', pageSize: 25 });
        expect(data.effectiveSettings).toEqual({ mfaRequired: false, marketingEmails: true });
        expect(data.invitations).toHaveLength(1);
        expect(data.activationTokens).toHaveLength(1);
        expect(data.activity.map((e) => e.type)).toEqual(
          expect.arrayContaining(['created', 'app.custom']),
        );
        const json = JSON.stringify(data);
        expect(json).not.toContain('tokenHash');
        expect(json).not.toContain(token);
        expect(audit.actions()).toContain('users.exported');
      });
    });

    describe('activity history', () => {
      it('records logins, paginates with cursors and prunes by retention', async () => {
        const u = await users.createUser({ email: 'act@example.com' });
        for (let i = 0; i < 5; i++) {
          clock.advance(DAY);
          await users.recordLogin(u.id, {
            ip: `10.0.0.${i}`,
            userAgent: 'Browser',
            metadata: { method: 'password' },
          });
        }
        expect((await users.getUser(u.id)).lastLoginAt).toBe(clock.now());
        const p1 = await users.listActivity(u.id, { type: 'login', limit: 3 });
        expect(p1.items.map((e) => e.ip)).toEqual(['10.0.0.4', '10.0.0.3', '10.0.0.2']);
        expect(p1.items[0]).toMatchObject({
          actorId: u.id,
          userAgent: 'Browser',
          metadata: { method: 'password' },
        });
        const p2 = await users.listActivity(u.id, {
          type: 'login',
          limit: 3,
          cursor: p1.nextCursor as string,
        });
        expect(p2.items.map((e) => e.ip)).toEqual(['10.0.0.1', '10.0.0.0']);
        expect(p2.nextCursor).toBeNull();
        expect(await users.pruneActivity({ olderThanMs: 2.5 * DAY })).toBe(3);
        expect((await users.listActivity(u.id)).items.map((e) => e.ip)).toEqual([
          '10.0.0.4',
          '10.0.0.3',
          '10.0.0.2',
        ]);
        await expectCode(
          users.recordActivity(u.id, { type: 'Bad Type' }),
          'USERS_VALIDATION_FAILED',
        );
        await expectCode(
          users.recordActivity(u.id, { type: 'x', metadata: { big: 'x'.repeat(5000) } }),
          'USERS_VALIDATION_FAILED',
        );
        await expectCode(users.recordLogin('missing'), 'USERS_NOT_FOUND');
      });

      it('runs maintenance through the job handler', async () => {
        const u = await users.createUser({ email: 'm@example.com' });
        await users.suspendUser(u.id, { reason: 'x', until: clock.now() + 1000 });
        clock.advance(400 * DAY);
        await createMaintenanceJobHandler(users)(
          {},
          { signal: new AbortController().signal, attempt: 1 },
        );
        const result = await users.runMaintenance();
        expect(result).toEqual({ purged: 0, reinstated: 0, activityPruned: 0 });
        expect((await store.getUser(u.id))?.status).toBe('active');
      });
    });

    describe('integration ports', () => {
      it('degrades gracefully when the audit sink fails', async () => {
        users = build({ audit: { record: async () => Promise.reject(new Error('down')) } });
        const u = await users.createUser({ email: 'audit@example.com' });
        expect(u.email).toBe('audit@example.com');
        expect(logger.entries.some((e) => e.msg === 'users audit sink failed')).toBe(true);
      });

      it('keeps working when the job queue fails', async () => {
        users = build({ jobs: { add: async () => Promise.reject(new Error('queue down')) } });
        const u = await users.createUser({ email: 'q@example.com' });
        expect((await users.requestDeletion(u.id)).status).toBe('deleted');
        expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
      });

      it('delegates can() to the PermissionChecker', async () => {
        expect(await users.can({ id: 'a' }, 'users:read')).toBe(false);
        const permissions = new FakePermissions({ a: ['users:read'] });
        users = build({ permissions });
        expect(users.hasPermissionChecker).toBe(true);
        expect(await users.can({ id: 'a' }, 'users:read', { type: 'user', id: 'x' })).toBe(true);
        expect(await users.can({ id: 'a' }, 'users:delete')).toBe(false);
      });

      it('rejects invalid configuration with named options', () => {
        expect(() => createUsers({} as UsersOptions)).toThrow(/options.store/);
        expect(() => build({ deletion: { gracePeriodMs: -1 } })).toThrow(/gracePeriodMs/);
        expect(() => build({ activation: { tokenTtlMs: 0 } })).toThrow(/tokenTtlMs/);
        expect(() => build({ deletion: { policy: 'shred' as never } })).toThrow(/policy/);
      });
    });
  });
}
