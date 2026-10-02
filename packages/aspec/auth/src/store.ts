/**
 * Persistence port of @aspec/auth. Implementations: `createMemoryAuthStore()` from
 * `@aspec/auth/memory` and `createSqlAuthStore()` from `@aspec/auth/sql`. Applications may
 * implement it for another database; run the contract tests in docs/testing.md against it.
 *
 * All timestamps are epoch milliseconds. Token values are never stored, only SHA-256 hashes.
 */

export interface AccountRecord {
  /** Application user ID. Use the same value as your users table or @aspec/users user ID. */
  id: string;
  /** Normalised email (NFKC, trimmed, lowercased). Unique. */
  email: string;
  emailVerifiedAt: number | null;
  /** Password hash string, or null for accounts that only use external identities or passkeys. */
  passwordHash: string | null;
  passwordChangedAt: number | null;
  failedLoginCount: number;
  lastFailedLoginAt: number | null;
  lockedUntil: number | null;
  /** Number of consecutive lockouts, used for exponential backoff. */
  lockoutLevel: number;
  disabledAt: number | null;
  /** AES-256-GCM encrypted TOTP secret (active). */
  totpSecret: string | null;
  /** AES-256-GCM encrypted TOTP secret awaiting confirmation during enrolment. */
  totpPendingSecret: string | null;
  /** Last accepted TOTP time step (replay prevention). */
  totpLastStep: number | null;
  mfaEnabledAt: number | null;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type AccountPatch = Partial<Omit<AccountRecord, 'id' | 'createdAt'>>;

export type AuthMethod = 'password' | 'oidc' | 'webauthn' | 'refresh' | 'custom';

export interface SessionRecord {
  id: string;
  accountId: string;
  /** SHA-256 hex of the opaque session token. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  /** Absolute expiry. */
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  authMethod: AuthMethod;
  /** True when multifactor authentication (or a passkey with user verification) was completed. */
  mfaVerified: boolean;
}

export interface RefreshTokenRecord {
  id: string;
  familyId: string;
  accountId: string;
  sessionId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export type OneTimeTokenPurpose =
  | 'password-reset'
  | 'email-verification'
  | 'email-change'
  | 'mfa-challenge'
  | 'oidc-transaction'
  | 'webauthn-registration'
  | 'webauthn-authentication';

export interface OneTimeTokenRecord {
  id: string;
  tokenHash: string;
  purpose: OneTimeTokenPurpose;
  accountId: string | null;
  /** Small JSON-serialisable payload (never secrets in clear text beyond what the flow needs). */
  data: Record<string, unknown> | null;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface RecoveryCodeRecord {
  id: string;
  accountId: string;
  codeHash: string;
  createdAt: number;
  usedAt: number | null;
}

export interface IdentityRecord {
  id: string;
  accountId: string;
  /** Provider ID from the OIDC configuration, for example `google`. */
  provider: string;
  /** Provider subject (`sub` claim or provider user ID). */
  subject: string;
  email: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface WebAuthnCredentialRecord {
  /** Credential ID (base64url). */
  id: string;
  accountId: string;
  /** COSE public key (base64url). */
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface AuthStore {
  // Accounts
  /** Returns false when the email is already taken. */
  createAccount(account: AccountRecord): Promise<boolean>;
  getAccountById(id: string): Promise<AccountRecord | undefined>;
  getAccountByEmail(email: string): Promise<AccountRecord | undefined>;
  /** Returns the updated record, or undefined when the account does not exist. Throws on email conflict. */
  updateAccount(id: string, patch: AccountPatch): Promise<AccountRecord | undefined>;
  /** Atomically increments failedLoginCount and returns the new value (0 when the account is missing). */
  incrementFailedLogins(id: string, at: number): Promise<number>;
  /**
   * Atomically records `step` as the last used TOTP step when it is greater than the stored one.
   * Returns false when the step was already used (replay).
   */
  advanceTotpStep(id: string, step: number): Promise<boolean>;
  /** Deletes the account and every related row. Returns false when it did not exist. */
  deleteAccount(id: string): Promise<boolean>;

  // Sessions
  createSession(session: SessionRecord): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  touchSession(id: string, lastSeenAt: number, ip: string | null): Promise<void>;
  listSessions(accountId: string): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<boolean>;
  /** Deletes all sessions of an account except `exceptSessionId`. Returns the deleted session IDs. */
  deleteSessionsByAccount(accountId: string, exceptSessionId?: string): Promise<string[]>;

  // Refresh tokens
  createRefreshToken(token: RefreshTokenRecord): Promise<void>;
  getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  /** Atomically sets usedAt when it is null. Returns false when the token was already used. */
  markRefreshTokenUsed(id: string, at: number): Promise<boolean>;
  /** Revokes every token of a family. Returns the number of tokens changed. */
  revokeRefreshFamily(familyId: string, at: number): Promise<number>;
  /** Revokes every refresh token bound to one of the sessions. */
  revokeRefreshTokensBySessions(sessionIds: readonly string[], at: number): Promise<number>;

  // One-time tokens (password reset, verification, MFA challenges, OIDC and WebAuthn transactions)
  createOneTimeToken(token: OneTimeTokenRecord): Promise<void>;
  /** Returns an unused token by hash and purpose (it may be expired; callers check expiresAt). */
  getOneTimeToken(
    tokenHash: string,
    purpose: OneTimeTokenPurpose,
  ): Promise<OneTimeTokenRecord | undefined>;
  /**
   * Atomically marks an unused, unexpired token as used and returns it. Returns undefined when the
   * token is unknown, expired, already used or has a different purpose.
   */
  consumeOneTimeToken(
    tokenHash: string,
    purpose: OneTimeTokenPurpose,
    now: number,
  ): Promise<OneTimeTokenRecord | undefined>;
  /** Atomically increments the attempt counter and returns the new value. */
  incrementOneTimeTokenAttempts(id: string): Promise<number>;
  /** Deletes unused tokens of an account for a purpose. Returns the number deleted. */
  deleteOneTimeTokens(accountId: string, purpose: OneTimeTokenPurpose): Promise<number>;
  /** Creation time of the newest token of an account for a purpose. */
  getLatestOneTimeTokenCreatedAt(
    accountId: string,
    purpose: OneTimeTokenPurpose,
  ): Promise<number | undefined>;

  // Recovery codes
  /** Replaces every recovery code of an account. */
  replaceRecoveryCodes(accountId: string, codes: readonly RecoveryCodeRecord[]): Promise<void>;
  /** Atomically marks an unused code as used. Returns false when unknown or already used. */
  consumeRecoveryCode(accountId: string, codeHash: string, at: number): Promise<boolean>;
  countUnusedRecoveryCodes(accountId: string): Promise<number>;

  // External identities
  /** Returns false when (provider, subject) is already linked. */
  createIdentity(identity: IdentityRecord): Promise<boolean>;
  getIdentity(provider: string, subject: string): Promise<IdentityRecord | undefined>;
  listIdentities(accountId: string): Promise<IdentityRecord[]>;
  touchIdentity(id: string, lastLoginAt: number, email: string | null): Promise<void>;
  deleteIdentity(accountId: string, provider: string, subject: string): Promise<boolean>;

  // WebAuthn credentials
  /** Returns false when the credential ID already exists. */
  createWebAuthnCredential(credential: WebAuthnCredentialRecord): Promise<boolean>;
  getWebAuthnCredential(id: string): Promise<WebAuthnCredentialRecord | undefined>;
  listWebAuthnCredentials(accountId: string): Promise<WebAuthnCredentialRecord[]>;
  updateWebAuthnCredentialUsage(
    id: string,
    counter: number,
    lastUsedAt: number,
    backedUp: boolean,
  ): Promise<void>;
  deleteWebAuthnCredential(accountId: string, id: string): Promise<boolean>;

  // Maintenance
  /** Deletes expired sessions, refresh tokens and one-time tokens. Returns rows deleted. */
  purgeExpired(now: number): Promise<number>;
}
