import { createPasswordPolicy, createScryptHasher, normalizeEmail } from '@aspec/auth';
import { createSqlAuthStore } from '@aspec/auth/sql';
import { ConflictError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import type { Platform } from './platform.js';

/**
 * Sign-in changes an administrator makes for someone else: a new password, a reset of
 * two-step verification and a new sign-in email. The auth service only offers these to the
 * account holder (they need the current password), so they are made on the account store.
 */
export class AccountAdmin {
  private readonly platform: Platform;
  private readonly store;
  private readonly hasher = createScryptHasher();
  private readonly policy = createPasswordPolicy({ minLength: 12 });

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = createSqlAuthStore(platform.db);
  }

  private async account(userId: string) {
    const account = await this.store.getAccountById(userId);
    if (!account) throw new NotFoundError('User not found');
    return account;
  }

  /** Sets a new password, clears any lockout and signs the user out everywhere. */
  async setPassword(userId: string, password: string, actor: Actor, tenantId: string) {
    await this.account(userId);
    try {
      await this.policy.check(password);
    } catch (error) {
      throw new UnprocessableError(
        error instanceof Error ? error.message : 'The password does not meet the policy.',
      );
    }
    const now = Date.now();
    await this.store.updateAccount(userId, {
      passwordHash: await this.hasher.hash(password),
      passwordChangedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
      lockoutLevel: 0,
      updatedAt: now,
    });
    await this.store.deleteOneTimeTokens(userId, 'password-reset');
    await this.platform.auth.revokeAllSessions(userId);
    await this.platform.audit.record({
      action: 'user.password.set_by_admin',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'user', id: userId },
      tenantId,
    });
  }

  /** Turns off two-step verification so the user can enrol again, for a lost device. */
  async resetTwoStep(userId: string, actor: Actor, tenantId: string) {
    await this.account(userId);
    await this.store.updateAccount(userId, {
      totpSecret: null,
      totpPendingSecret: null,
      totpLastStep: null,
      mfaEnabledAt: null,
      updatedAt: Date.now(),
    });
    await this.store.replaceRecoveryCodes(userId, []);
    await this.platform.auth.revokeAllSessions(userId);
    await this.platform.audit.record({
      action: 'user.mfa.reset_by_admin',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'user', id: userId },
      tenantId,
    });
  }

  /** Changes the sign-in email of the account and its directory profile together. */
  async changeEmail(userId: string, email: string, actor: Actor, tenantId: string) {
    const account = await this.account(userId);
    const next = normalizeEmail(email);
    if (!next) throw new UnprocessableError('Enter a valid email address.');
    if (next === account.email) return;
    const taken = await this.store.getAccountByEmail(next);
    if (taken && taken.id !== userId) {
      throw new ConflictError('That email address is already in use.');
    }
    await this.platform.db.transaction(async () => {
      await this.store.updateAccount(userId, { email: next, updatedAt: Date.now() });
      await this.platform.users.changeEmail(userId, next, {}, { actor });
    });
    await this.platform.audit.record({
      action: 'user.email.changed_by_admin',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'user', id: userId },
      tenantId,
      changes: { before: { email: account.email }, after: { email: next } },
    });
  }
}
