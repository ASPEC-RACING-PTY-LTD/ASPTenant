import { AuthError } from '../errors.js';
import type { Clock } from '../ports.js';
import type {
  AccountPatch,
  AccountRecord,
  AuthStore,
  IdentityRecord,
  OneTimeTokenPurpose,
  OneTimeTokenRecord,
  RecoveryCodeRecord,
  RefreshTokenRecord,
  SessionRecord,
  WebAuthnCredentialRecord,
} from '../store.js';

export interface MemoryAuthStoreOptions {
  /** Maximum accounts. Default 100000. */
  maxAccounts?: number;
  /** Maximum sessions, refresh tokens and one-time tokens (each). Default 100000. */
  maxTokens?: number;
  /** Minimum interval between expiry sweeps triggered by writes. Default 60000 ms. */
  sweepIntervalMs?: number;
  clock?: Clock;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory AuthStore for development, tests and single-process prototypes. Bounded: writes
 * beyond the configured caps (after sweeping expired rows) throw AUTH_STORE_FULL. Data is lost
 * when the process exits.
 */
export function createMemoryAuthStore(options: MemoryAuthStoreOptions = {}): AuthStore {
  const maxAccounts = options.maxAccounts ?? 100_000;
  const maxTokens = options.maxTokens ?? 100_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  const clock = options.clock ?? { now: () => Date.now() };

  const accounts = new Map<string, AccountRecord>();
  const accountsByEmail = new Map<string, string>();
  const sessions = new Map<string, SessionRecord>();
  const sessionsByHash = new Map<string, string>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const refreshByHash = new Map<string, string>();
  const oneTimeTokens = new Map<string, OneTimeTokenRecord>();
  const oneTimeByHash = new Map<string, string>();
  const recoveryCodes = new Map<string, RecoveryCodeRecord[]>();
  const identities = new Map<string, IdentityRecord>();
  const identityKey = (provider: string, subject: string) => `${provider}\u0000${subject}`;
  const credentials = new Map<string, WebAuthnCredentialRecord>();
  let lastSweep = 0;

  const purge = (now: number): number => {
    let removed = 0;
    for (const [id, s] of sessions) {
      if (s.expiresAt <= now) {
        sessions.delete(id);
        sessionsByHash.delete(s.tokenHash);
        removed++;
      }
    }
    for (const [id, t] of refreshTokens) {
      if (t.expiresAt <= now) {
        refreshTokens.delete(id);
        refreshByHash.delete(t.tokenHash);
        removed++;
      }
    }
    for (const [id, t] of oneTimeTokens) {
      if (t.expiresAt <= now || t.usedAt !== null) {
        oneTimeTokens.delete(id);
        oneTimeByHash.delete(t.tokenHash);
        removed++;
      }
    }
    lastSweep = now;
    return removed;
  };

  const assertCapacity = (collection: Map<string, unknown>) => {
    const now = clock.now();
    if (now - lastSweep >= sweepIntervalMs || collection.size >= maxTokens) purge(now);
    if (collection.size >= maxTokens) throw new AuthError('AUTH_STORE_FULL');
  };

  const store: AuthStore = {
    async createAccount(account) {
      if (accountsByEmail.has(account.email) || accounts.has(account.id)) return false;
      if (accounts.size >= maxAccounts) throw new AuthError('AUTH_STORE_FULL');
      accounts.set(account.id, clone(account));
      accountsByEmail.set(account.email, account.id);
      return true;
    },
    async getAccountById(id) {
      const a = accounts.get(id);
      return a ? clone(a) : undefined;
    },
    async getAccountByEmail(email) {
      const id = accountsByEmail.get(email);
      const a = id === undefined ? undefined : accounts.get(id);
      return a ? clone(a) : undefined;
    },
    async updateAccount(id, patch: AccountPatch) {
      const a = accounts.get(id);
      if (!a) return undefined;
      if (patch.email !== undefined && patch.email !== a.email) {
        const other = accountsByEmail.get(patch.email);
        if (other !== undefined && other !== id) throw new AuthError('AUTH_EMAIL_TAKEN');
        accountsByEmail.delete(a.email);
        accountsByEmail.set(patch.email, id);
      }
      const updated: AccountRecord = { ...a };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (updated as unknown as Record<string, unknown>)[k] = v;
      }
      accounts.set(id, updated);
      return clone(updated);
    },
    async incrementFailedLogins(id, at) {
      const a = accounts.get(id);
      if (!a) return 0;
      a.failedLoginCount += 1;
      a.lastFailedLoginAt = at;
      a.updatedAt = at;
      return a.failedLoginCount;
    },
    async advanceTotpStep(id, step) {
      const a = accounts.get(id);
      if (!a) return false;
      if (a.totpLastStep !== null && a.totpLastStep >= step) return false;
      a.totpLastStep = step;
      return true;
    },
    async deleteAccount(id) {
      const a = accounts.get(id);
      if (!a) return false;
      accounts.delete(id);
      accountsByEmail.delete(a.email);
      for (const [sid, s] of sessions) {
        if (s.accountId === id) {
          sessions.delete(sid);
          sessionsByHash.delete(s.tokenHash);
        }
      }
      for (const [tid, t] of refreshTokens) {
        if (t.accountId === id) {
          refreshTokens.delete(tid);
          refreshByHash.delete(t.tokenHash);
        }
      }
      for (const [tid, t] of oneTimeTokens) {
        if (t.accountId === id) {
          oneTimeTokens.delete(tid);
          oneTimeByHash.delete(t.tokenHash);
        }
      }
      recoveryCodes.delete(id);
      for (const [key, i] of identities) if (i.accountId === id) identities.delete(key);
      for (const [cid, c] of credentials) if (c.accountId === id) credentials.delete(cid);
      return true;
    },

    async createSession(session) {
      assertCapacity(sessions);
      sessions.set(session.id, clone(session));
      sessionsByHash.set(session.tokenHash, session.id);
    },
    async getSessionByTokenHash(tokenHash) {
      const id = sessionsByHash.get(tokenHash);
      const s = id === undefined ? undefined : sessions.get(id);
      return s ? clone(s) : undefined;
    },
    async getSession(id) {
      const s = sessions.get(id);
      return s ? clone(s) : undefined;
    },
    async touchSession(id, lastSeenAt, ip) {
      const s = sessions.get(id);
      if (!s) return;
      s.lastSeenAt = lastSeenAt;
      if (ip !== null) s.ip = ip;
    },
    async listSessions(accountId) {
      return [...sessions.values()]
        .filter((s) => s.accountId === accountId)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(clone);
    },
    async deleteSession(id) {
      const s = sessions.get(id);
      if (!s) return false;
      sessions.delete(id);
      sessionsByHash.delete(s.tokenHash);
      return true;
    },
    async deleteSessionsByAccount(accountId, exceptSessionId) {
      const deleted: string[] = [];
      for (const [id, s] of sessions) {
        if (s.accountId === accountId && id !== exceptSessionId) {
          sessions.delete(id);
          sessionsByHash.delete(s.tokenHash);
          deleted.push(id);
        }
      }
      return deleted;
    },

    async createRefreshToken(token) {
      assertCapacity(refreshTokens);
      refreshTokens.set(token.id, clone(token));
      refreshByHash.set(token.tokenHash, token.id);
    },
    async getRefreshTokenByHash(tokenHash) {
      const id = refreshByHash.get(tokenHash);
      const t = id === undefined ? undefined : refreshTokens.get(id);
      return t ? clone(t) : undefined;
    },
    async markRefreshTokenUsed(id, at) {
      const t = refreshTokens.get(id);
      if (!t || t.usedAt !== null) return false;
      t.usedAt = at;
      return true;
    },
    async revokeRefreshFamily(familyId, at) {
      let n = 0;
      for (const t of refreshTokens.values()) {
        if (t.familyId === familyId && t.revokedAt === null) {
          t.revokedAt = at;
          n++;
        }
      }
      return n;
    },
    async revokeRefreshTokensBySessions(sessionIds, at) {
      const set = new Set(sessionIds);
      let n = 0;
      for (const t of refreshTokens.values()) {
        if (set.has(t.sessionId) && t.revokedAt === null) {
          t.revokedAt = at;
          n++;
        }
      }
      return n;
    },

    async createOneTimeToken(token) {
      assertCapacity(oneTimeTokens);
      oneTimeTokens.set(token.id, clone(token));
      oneTimeByHash.set(token.tokenHash, token.id);
    },
    async getOneTimeToken(tokenHash, purpose) {
      const id = oneTimeByHash.get(tokenHash);
      const t = id === undefined ? undefined : oneTimeTokens.get(id);
      if (!t || t.purpose !== purpose || t.usedAt !== null) return undefined;
      return clone(t);
    },
    async consumeOneTimeToken(tokenHash, purpose, now) {
      const id = oneTimeByHash.get(tokenHash);
      const t = id === undefined ? undefined : oneTimeTokens.get(id);
      if (!t || t.purpose !== purpose || t.usedAt !== null || t.expiresAt <= now) return undefined;
      t.usedAt = now;
      return clone(t);
    },
    async incrementOneTimeTokenAttempts(id) {
      const t = oneTimeTokens.get(id);
      if (!t) return Number.MAX_SAFE_INTEGER;
      t.attempts += 1;
      return t.attempts;
    },
    async deleteOneTimeTokens(accountId, purpose: OneTimeTokenPurpose) {
      let n = 0;
      for (const [id, t] of oneTimeTokens) {
        if (t.accountId === accountId && t.purpose === purpose && t.usedAt === null) {
          oneTimeTokens.delete(id);
          oneTimeByHash.delete(t.tokenHash);
          n++;
        }
      }
      return n;
    },
    async getLatestOneTimeTokenCreatedAt(accountId, purpose) {
      let latest: number | undefined;
      for (const t of oneTimeTokens.values()) {
        if (
          t.accountId === accountId &&
          t.purpose === purpose &&
          (latest === undefined || t.createdAt > latest)
        ) {
          latest = t.createdAt;
        }
      }
      return latest;
    },

    async replaceRecoveryCodes(accountId, codes) {
      recoveryCodes.set(accountId, codes.map(clone));
    },
    async consumeRecoveryCode(accountId, codeHash, at) {
      const code = recoveryCodes.get(accountId)?.find((c) => c.codeHash === codeHash);
      if (!code || code.usedAt !== null) return false;
      code.usedAt = at;
      return true;
    },
    async countUnusedRecoveryCodes(accountId) {
      return (recoveryCodes.get(accountId) ?? []).filter((c) => c.usedAt === null).length;
    },

    async createIdentity(identity) {
      const key = identityKey(identity.provider, identity.subject);
      if (identities.has(key)) return false;
      if (identities.size >= maxAccounts) throw new AuthError('AUTH_STORE_FULL');
      identities.set(key, clone(identity));
      return true;
    },
    async getIdentity(provider, subject) {
      const i = identities.get(identityKey(provider, subject));
      return i ? clone(i) : undefined;
    },
    async listIdentities(accountId) {
      return [...identities.values()].filter((i) => i.accountId === accountId).map(clone);
    },
    async touchIdentity(id, lastLoginAt, email) {
      for (const i of identities.values()) {
        if (i.id === id) {
          i.lastLoginAt = lastLoginAt;
          if (email !== null) i.email = email;
        }
      }
    },
    async deleteIdentity(accountId, provider, subject) {
      const key = identityKey(provider, subject);
      const i = identities.get(key);
      if (!i || i.accountId !== accountId) return false;
      identities.delete(key);
      return true;
    },

    async createWebAuthnCredential(credential) {
      if (credentials.has(credential.id)) return false;
      if (credentials.size >= maxAccounts) throw new AuthError('AUTH_STORE_FULL');
      credentials.set(credential.id, clone(credential));
      return true;
    },
    async getWebAuthnCredential(id) {
      const c = credentials.get(id);
      return c ? clone(c) : undefined;
    },
    async listWebAuthnCredentials(accountId) {
      return [...credentials.values()]
        .filter((c) => c.accountId === accountId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
    },
    async updateWebAuthnCredentialUsage(id, counter, lastUsedAt, backedUp) {
      const c = credentials.get(id);
      if (!c) return;
      c.counter = counter;
      c.lastUsedAt = lastUsedAt;
      c.backedUp = backedUp;
    },
    async deleteWebAuthnCredential(accountId, id) {
      const c = credentials.get(id);
      if (!c || c.accountId !== accountId) return false;
      credentials.delete(id);
      return true;
    },

    async purgeExpired(now) {
      return purge(now);
    },
  };

  return store;
}
