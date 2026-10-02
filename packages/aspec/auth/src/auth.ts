import { randomUUID } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  createFieldEncryptor,
  decodeKey,
  type FieldEncryptor,
  randomToken,
  sha256Hex,
} from './crypto.js';
import { normalizeEmail, requireEmail } from './email.js';
import { AuthError, configError } from './errors.js';
import { type AuthEmailTemplates, defaultEmailTemplates, type EmailContent } from './mail.js';
import {
  createPasswordPolicy,
  createScryptHasher,
  isPlausiblePassword,
  type PasswordHasher,
  type PasswordPolicy,
  type PasswordPolicyOptions,
} from './password.js';
import type {
  AuditEventInput,
  AuditSink,
  Clock,
  IdGenerator,
  LoggerLike,
  Mailer,
  RateLimiterLike,
} from './ports.js';
import { createMemoryRateLimiter } from './rate-limit.js';
import type {
  AccountRecord,
  AuthMethod,
  AuthStore,
  OneTimeTokenPurpose,
  SessionRecord,
} from './store.js';
import {
  type AccessTokenClaims,
  type AccessTokenIssuer,
  type AccessTokenOptions,
  createAccessTokenIssuer,
} from './tokens.js';
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  type ResolvedTotpOptions,
  resolveTotpOptions,
  type TotpOptions,
  verifyTotp,
} from './totp.js';

/** Request metadata recorded on sessions and audit events. */
export interface RequestContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export type LinkBuilder = string | ((token: string) => string);

export interface SessionOptions {
  /** Session ends after this much inactivity. Default 86400000 (24 hours). */
  idleTimeoutMs?: number;
  /** Session ends this long after creation regardless of activity. Default 2592000000 (30 days). */
  absoluteTimeoutMs?: number;
  /** Minimum interval between last-seen updates. Default 60000 (1 minute). */
  touchIntervalMs?: number;
}

export interface TokenOptions extends AccessTokenOptions {
  /** Refresh token lifetime (also bounded by the session absolute lifetime). Default 2592000000 (30 days). */
  refreshTokenTtlMs?: number;
}

export type RevealLockedState = 'after-valid-password' | 'always' | 'never';

export interface LockoutOptions {
  /** Default true. */
  enabled?: boolean;
  /** Consecutive failures that trigger a lockout. Default 5. */
  maxFailures?: number;
  /** First lockout duration. Default 300000 (5 minutes). */
  baseDurationMs?: number;
  /** Multiplier applied for every consecutive lockout. Default 2. */
  factor?: number;
  /** Upper bound for a lockout. Default 3600000 (1 hour). */
  maxDurationMs?: number;
  /** The backoff level resets when the previous lockout ended longer ago than this. Default 86400000. */
  levelResetMs?: number;
  /** Send an `auth.lockout` email when an account is locked (requires a mailer). Default true. */
  notify?: boolean;
  /**
   * When locked (or disabled) accounts receive their specific error instead of the generic
   * AUTH_INVALID_CREDENTIALS. Default `after-valid-password`.
   */
  revealLockedState?: RevealLockedState;
}

export interface BuiltInRateLimitOptions {
  /** Window for the built-in limiter. Default 900000 (15 minutes). */
  windowMs?: number;
  /** Login attempts per IP per window. Default 100. */
  loginPerIp?: number;
  /** Login attempts per normalised email per window. Default 10. */
  loginPerEmail?: number;
  /** Password reset requests per email (and per IP x 10) per window. Default 5. */
  passwordResetPerEmail?: number;
  /** MFA and re-authentication attempts per account per window. Default 10. */
  verificationPerAccount?: number;
}

export interface MfaOptions {
  /** 32-byte AES-256-GCM key (base64 or raw bytes) that encrypts TOTP secrets at rest. */
  encryptionKey: string | Uint8Array;
  /** Older keys still accepted for decryption during key rotation. */
  previousEncryptionKeys?: ReadonlyArray<string | Uint8Array>;
  /** Issuer shown in authenticator apps. Default: appName. */
  issuer?: string;
  totp?: TotpOptions;
  /** Recovery codes generated on enrolment. Default 10. */
  recoveryCodeCount?: number;
  /** MFA challenge lifetime after a correct password. Default 300000 (5 minutes). */
  challengeTtlMs?: number;
  /** Wrong codes accepted per challenge before it is invalidated. Default 5. */
  maxChallengeAttempts?: number;
}

export interface AuthOptions {
  store: AuthStore;
  mailer?: Mailer;
  rateLimiter?: RateLimiterLike;
  audit?: AuditSink;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  hasher?: PasswordHasher;
  /** Application name used in emails and as the default TOTP issuer. Default `Application`. */
  appName?: string;
  /**
   * Link builders for emails. A string is used as a base URL and receives a `token` query
   * parameter; a function receives the token and returns the full URL. Required with a mailer.
   */
  links?: { passwordReset?: LinkBuilder; emailVerification?: LinkBuilder };
  emailTemplates?: Partial<AuthEmailTemplates>;
  /** `background` (default) sends email without delaying the response; `await` waits for the mailer. */
  mailDispatch?: 'background' | 'await';
  passwordPolicy?: PasswordPolicyOptions;
  session?: SessionOptions;
  /** Enables JWT access tokens and rotating refresh tokens for API clients. */
  tokens?: TokenOptions;
  lockout?: LockoutOptions;
  /** Limits of the built-in in-memory limiter (ignored when `rateLimiter` is provided). */
  rateLimit?: BuiltInRateLimitOptions;
  passwordReset?: {
    /** Default 1800000 (30 minutes). */
    tokenTtlMs?: number;
    /** Revoke every session and refresh token after a reset. Default true. */
    revokeSessions?: boolean;
  };
  emailVerification?: {
    /** Default 86400000 (24 hours). */
    tokenTtlMs?: number;
    /** Minimum interval between verification emails for one account. Default 60000. */
    resendIntervalMs?: number;
    /** Reject password logins until the email is verified. Default false. */
    required?: boolean;
    /** Send (or return) a verification token on registration. Default true. */
    sendOnRegister?: boolean;
  };
  changePassword?: {
    /** Revoke other sessions after a password change. Default true. */
    revokeOtherSessions?: boolean;
  };
  mfa?: MfaOptions;
}

/** Account data safe to return to clients and applications (no hashes or secrets). */
export interface PublicAccount {
  id: string;
  email: string;
  emailVerified: boolean;
  emailVerifiedAt: number | null;
  hasPassword: boolean;
  mfaEnabled: boolean;
  disabled: boolean;
  lockedUntil: number | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface SessionInfo {
  id: string;
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  idleExpiresAt: number;
  ip: string | null;
  userAgent: string | null;
  authMethod: AuthMethod;
  mfaVerified: boolean;
  current?: boolean;
}

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export interface AuthenticatedResult {
  status: 'authenticated';
  account: PublicAccount;
  session: SessionInfo;
  /** Opaque session token. Store it in a cookie (see cookie helpers) or keep it server side. */
  sessionToken: string;
  tokens?: TokenPair;
}

export interface MfaRequiredResult {
  status: 'mfa_required';
  /** Short-lived single-use token to pass to completeMfaChallenge. */
  challengeToken: string;
  expiresAt: number;
  methods: Array<'totp' | 'recovery_code'>;
}

export type LoginResult = AuthenticatedResult | MfaRequiredResult;

export interface SessionAuth {
  account: PublicAccount;
  session: SessionInfo;
}

export interface AccessTokenAuth extends SessionAuth {
  claims: AccessTokenClaims;
}

export type ReauthProof = { password: string } | { totp: string };

/** Internals shared with the OIDC and WebAuthn subpaths. Not needed by most applications. */
export interface AuthInternals {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly generateId: IdGenerator;
  readonly logger: LoggerLike;
  readonly appName: string;
  recordAudit(event: AuditEventInput): Promise<void>;
  context(
    ctx: RequestContext | undefined,
    accountId?: string,
  ): Pick<AuditEventInput, 'actor' | 'requestId'>;
}

export interface Auth {
  readonly internals: AuthInternals;
  readonly config: {
    readonly session: Required<SessionOptions>;
    readonly tokensEnabled: boolean;
    readonly mfaEnabled: boolean;
    readonly hasMailer: boolean;
    readonly passwordPolicy: { minLength: number; maxLength: number };
  };
  register(input: {
    email: string;
    password: string;
    /** Use an existing application user ID as the account ID. Default: generated. */
    id?: string;
    context?: RequestContext;
  }): Promise<{ account: PublicAccount; verificationToken?: string }>;
  /** Creates an account without a password (external identities, passkeys, invitations). */
  createAccount(input: {
    email: string;
    emailVerified?: boolean;
    id?: string;
    context?: RequestContext;
  }): Promise<PublicAccount>;
  login(input: {
    email: string;
    password: string;
    context?: RequestContext;
    /** Current session token, revoked on success (prevents session fixation). */
    currentSessionToken?: string;
    /** Also issue a JWT access token and refresh token (requires `tokens`). */
    issueTokens?: boolean;
  }): Promise<LoginResult>;
  completeMfaChallenge(input: {
    challengeToken: string;
    code?: string;
    recoveryCode?: string;
    context?: RequestContext;
    currentSessionToken?: string;
    issueTokens?: boolean;
  }): Promise<AuthenticatedResult>;
  /** Signs in an account after a trusted authentication step (OIDC, passkeys, custom flows). */
  signIn(
    accountId: string,
    input: {
      method: AuthMethod;
      context?: RequestContext;
      /** True when the step already provided multifactor assurance (passkey with user verification). */
      mfaVerified?: boolean;
      /** Require the local TOTP challenge when enabled for the account. Default true. */
      enforceMfa?: boolean;
      currentSessionToken?: string;
      issueTokens?: boolean;
    },
  ): Promise<LoginResult>;
  authenticateSession(sessionToken: string, context?: RequestContext): Promise<SessionAuth>;
  authenticateAccessToken(accessToken: string, context?: RequestContext): Promise<AccessTokenAuth>;
  logout(sessionToken: string, context?: RequestContext): Promise<void>;
  refresh(
    refreshToken: string,
    context?: RequestContext,
  ): Promise<{ account: PublicAccount; session: SessionInfo; tokens: TokenPair }>;
  /** Issues access and refresh tokens for an existing valid session. */
  issueTokens(sessionToken: string, context?: RequestContext): Promise<TokenPair>;
  rotateSession(
    sessionToken: string,
    context?: RequestContext,
  ): Promise<{ sessionToken: string; session: SessionInfo }>;
  listSessions(accountId: string, currentSessionId?: string): Promise<SessionInfo[]>;
  revokeSession(accountId: string, sessionId: string, context?: RequestContext): Promise<boolean>;
  revokeAllSessions(
    accountId: string,
    options?: { exceptSessionId?: string; context?: RequestContext },
  ): Promise<number>;
  changePassword(input: {
    accountId: string;
    currentPassword: string;
    newPassword: string;
    /** Cookie sessions: the current session is kept and its token rotated. */
    currentSessionToken?: string;
    /** Bearer sessions: the session to keep (its access tokens stay valid). */
    currentSessionId?: string;
    context?: RequestContext;
  }): Promise<{ sessionToken?: string; session?: SessionInfo }>;
  requestPasswordReset(input: {
    email: string;
    context?: RequestContext;
  }): Promise<{ token?: string }>;
  resetPassword(input: {
    token: string;
    newPassword: string;
    context?: RequestContext;
  }): Promise<{ accountId: string }>;
  sendEmailVerification(
    accountId: string,
    context?: RequestContext,
  ): Promise<{ token?: string; alreadyVerified?: boolean }>;
  verifyEmail(input: {
    token: string;
    context?: RequestContext;
  }): Promise<{ accountId: string; email: string }>;
  changeEmail(input: {
    accountId: string;
    newEmail: string;
    currentPassword?: string;
    context?: RequestContext;
  }): Promise<{ token?: string }>;
  getAccount(accountId: string): Promise<PublicAccount | undefined>;
  getAccountByEmail(email: string): Promise<PublicAccount | undefined>;
  unlockAccount(
    accountId: string,
    options?: { actorId?: string; context?: RequestContext },
  ): Promise<void>;
  disableAccount(
    accountId: string,
    options?: { actorId?: string; context?: RequestContext },
  ): Promise<void>;
  enableAccount(
    accountId: string,
    options?: { actorId?: string; context?: RequestContext },
  ): Promise<void>;
  deleteAccount(
    accountId: string,
    options?: { actorId?: string; context?: RequestContext },
  ): Promise<boolean>;
  beginTotpEnrollment(accountId: string): Promise<{ secret: string; otpauthUri: string }>;
  confirmTotpEnrollment(
    accountId: string,
    code: string,
    options?: { currentSessionToken?: string; context?: RequestContext },
  ): Promise<{ recoveryCodes: string[]; sessionToken?: string; session?: SessionInfo }>;
  disableTotp(accountId: string, proof: ReauthProof, context?: RequestContext): Promise<void>;
  regenerateRecoveryCodes(
    accountId: string,
    proof: ReauthProof,
    context?: RequestContext,
  ): Promise<string[]>;
  getMfaStatus(accountId: string): Promise<{ enabled: boolean; recoveryCodesRemaining: number }>;
  /** Public JWKS of the access token signing key (empty for HS256 or when tokens are disabled). */
  jwks(): { keys: Array<Record<string, unknown>> };
  /** Deletes expired sessions and tokens. Schedule it (for example hourly) with SQL stores. */
  purgeExpired(): Promise<number>;
  /** Resolves when background emails have settled (tests and graceful shutdown). */
  idle(): Promise<void>;
}

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

function positiveInt(value: number, option: string, min = 1): number {
  if (!Number.isInteger(value) || value < min) configError(option, `must be an integer >= ${min}`);
  return value;
}

function buildLink(builder: LinkBuilder, token: string): string {
  if (typeof builder === 'function') return builder(token);
  const url = new URL(builder);
  url.searchParams.set('token', token);
  return url.toString();
}

function isSafeId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  for (let i = 0; i < value.length; i++) {
    if ((value.charCodeAt(i) as number) < 32) return false;
  }
  return true;
}

function isTokenString(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512;
}

export function createAuth(options: AuthOptions): Auth {
  if (!options || typeof options !== 'object') configError('options', 'must be an object');
  const store = options.store;
  if (!store || typeof store.createAccount !== 'function')
    configError('store', 'must implement AuthStore');
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const generateId: IdGenerator = options.generateId ?? (() => randomUUID());
  const logger = options.logger ?? noopLogger;
  const hasher = options.hasher ?? createScryptHasher();
  const appName = options.appName ?? 'Application';
  const mailer = options.mailer;
  const templates: AuthEmailTemplates = { ...defaultEmailTemplates, ...options.emailTemplates };
  const mailDispatch = options.mailDispatch ?? 'background';
  const policy: PasswordPolicy = createPasswordPolicy(options.passwordPolicy);

  if (mailer) {
    if (!options.links?.passwordReset)
      configError('links.passwordReset', 'is required when a mailer is configured');
    if (!options.links?.emailVerification) {
      configError('links.emailVerification', 'is required when a mailer is configured');
    }
  }
  for (const [name, builder] of Object.entries(options.links ?? {})) {
    if (typeof builder === 'string') {
      try {
        new URL(builder);
      } catch {
        configError(`links.${name}`, 'must be an absolute URL');
      }
    }
  }

  const session: Required<SessionOptions> = {
    idleTimeoutMs: positiveInt(
      options.session?.idleTimeoutMs ?? 86_400_000,
      'session.idleTimeoutMs',
      60_000,
    ),
    absoluteTimeoutMs: positiveInt(
      options.session?.absoluteTimeoutMs ?? 2_592_000_000,
      'session.absoluteTimeoutMs',
      60_000,
    ),
    touchIntervalMs: positiveInt(
      options.session?.touchIntervalMs ?? 60_000,
      'session.touchIntervalMs',
      0,
    ),
  };
  if (session.idleTimeoutMs > session.absoluteTimeoutMs) {
    configError('session.idleTimeoutMs', 'must not exceed session.absoluteTimeoutMs');
  }

  const lockout = {
    enabled: options.lockout?.enabled ?? true,
    maxFailures: positiveInt(options.lockout?.maxFailures ?? 5, 'lockout.maxFailures'),
    baseDurationMs: positiveInt(
      options.lockout?.baseDurationMs ?? 300_000,
      'lockout.baseDurationMs',
      1000,
    ),
    factor: options.lockout?.factor ?? 2,
    maxDurationMs: positiveInt(
      options.lockout?.maxDurationMs ?? 3_600_000,
      'lockout.maxDurationMs',
      1000,
    ),
    levelResetMs: positiveInt(
      options.lockout?.levelResetMs ?? 86_400_000,
      'lockout.levelResetMs',
      1000,
    ),
    notify: options.lockout?.notify ?? true,
    reveal: options.lockout?.revealLockedState ?? 'after-valid-password',
  };
  if (typeof lockout.factor !== 'number' || lockout.factor < 1 || lockout.factor > 10) {
    configError('lockout.factor', 'must be between 1 and 10');
  }
  if (lockout.maxDurationMs < lockout.baseDurationMs)
    configError('lockout.maxDurationMs', 'must be >= baseDurationMs');
  if (!['after-valid-password', 'always', 'never'].includes(lockout.reveal)) {
    configError('lockout.revealLockedState', 'must be after-valid-password, always or never');
  }

  const resetTtl = positiveInt(
    options.passwordReset?.tokenTtlMs ?? 1_800_000,
    'passwordReset.tokenTtlMs',
    60_000,
  );
  const resetRevokes = options.passwordReset?.revokeSessions ?? true;
  const verifyTtl = positiveInt(
    options.emailVerification?.tokenTtlMs ?? 86_400_000,
    'emailVerification.tokenTtlMs',
    60_000,
  );
  const resendInterval = positiveInt(
    options.emailVerification?.resendIntervalMs ?? 60_000,
    'emailVerification.resendIntervalMs',
    0,
  );
  const requireVerified = options.emailVerification?.required ?? false;
  const sendOnRegister = options.emailVerification?.sendOnRegister ?? true;
  const revokeOnPasswordChange = options.changePassword?.revokeOtherSessions ?? true;

  // Rate limiting: one injected limiter for every bucket, or built-in limiters per bucket.
  const rl = options.rateLimit ?? {};
  const windowMs = positiveInt(rl.windowMs ?? 900_000, 'rateLimit.windowMs', 1000);
  const limiterFor = (limit: number, option: string): RateLimiterLike =>
    options.rateLimiter ??
    createMemoryRateLimiter({ limit: positiveInt(limit, option), windowMs, clock });
  const limiters = {
    loginIp: limiterFor(rl.loginPerIp ?? 100, 'rateLimit.loginPerIp'),
    loginEmail: limiterFor(rl.loginPerEmail ?? 10, 'rateLimit.loginPerEmail'),
    resetEmail: limiterFor(rl.passwordResetPerEmail ?? 5, 'rateLimit.passwordResetPerEmail'),
    resetIp: limiterFor((rl.passwordResetPerEmail ?? 5) * 10, 'rateLimit.passwordResetPerEmail'),
    verification: limiterFor(rl.verificationPerAccount ?? 10, 'rateLimit.verificationPerAccount'),
  };

  let accessTokens: AccessTokenIssuer | undefined;
  let refreshTtl = 0;
  if (options.tokens) {
    accessTokens = createAccessTokenIssuer(options.tokens);
    refreshTtl = positiveInt(
      options.tokens.refreshTokenTtlMs ?? 2_592_000_000,
      'tokens.refreshTokenTtlMs',
      60_000,
    );
  }

  let encryptor: FieldEncryptor | undefined;
  let totpOptions: ResolvedTotpOptions | undefined;
  const mfaConfig = {
    issuer: options.mfa?.issuer ?? appName,
    recoveryCodeCount: positiveInt(options.mfa?.recoveryCodeCount ?? 10, 'mfa.recoveryCodeCount'),
    challengeTtlMs: positiveInt(
      options.mfa?.challengeTtlMs ?? 300_000,
      'mfa.challengeTtlMs',
      30_000,
    ),
    maxChallengeAttempts: positiveInt(
      options.mfa?.maxChallengeAttempts ?? 5,
      'mfa.maxChallengeAttempts',
    ),
  };
  if (options.mfa) {
    if (options.mfa.encryptionKey === undefined) configError('mfa.encryptionKey', 'is required');
    const key = decodeKey(options.mfa.encryptionKey, 'mfa.encryptionKey', 32);
    if (key.length !== 32) configError('mfa.encryptionKey', 'must decode to exactly 32 bytes');
    const previous = (options.mfa.previousEncryptionKeys ?? []).map((k, i) =>
      decodeKey(k, `mfa.previousEncryptionKeys[${i}]`, 32),
    );
    encryptor = createFieldEncryptor(key, previous);
    totpOptions = resolveTotpOptions(options.mfa.totp);
  }

  // Dummy hash used to equalise timing when the account does not exist or has no password.
  let dummyHash: Promise<string> | undefined;
  const dummyVerify = async (password: string) => {
    dummyHash ??= hasher.hash(randomToken(24));
    await hasher.verify(await dummyHash, password);
  };

  const pending = new Set<Promise<void>>();

  // ---------- helpers ----------

  const context = (
    ctx: RequestContext | undefined,
    accountId?: string,
  ): Pick<AuditEventInput, 'actor' | 'requestId'> => {
    const actor: NonNullable<AuditEventInput['actor']> = accountId
      ? { id: accountId, type: 'user' }
      : { id: 'anonymous', type: 'anonymous' };
    if (ctx?.ip) actor.ip = ctx.ip;
    if (ctx?.userAgent) actor.userAgent = ctx.userAgent;
    return ctx?.requestId ? { actor, requestId: ctx.requestId } : { actor };
  };

  const recordAudit = async (event: AuditEventInput): Promise<void> => {
    if (!options.audit) return;
    try {
      await options.audit.record({ category: 'security', ...event });
    } catch (err) {
      logger.error({ err: errorSummary(err), action: event.action }, 'auth audit sink failed');
    }
  };

  const audit = (
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    ctx: RequestContext | undefined,
    accountId: string | undefined,
    metadata?: Record<string, unknown>,
  ) =>
    recordAudit({
      action,
      outcome,
      ...context(ctx, accountId),
      ...(accountId ? { resource: { type: 'auth.account', id: accountId } } : {}),
      ...(metadata ? { metadata } : {}),
    });

  const sendMail = async (
    to: string,
    content: EmailContent,
    category: string,
    accountId: string,
  ) => {
    if (!mailer) return;
    const job = mailer
      .send({
        to,
        subject: content.subject,
        text: content.text,
        ...(content.html ? { html: content.html } : {}),
        category,
        metadata: { accountId },
      })
      .then(
        () => undefined,
        (err: unknown) => {
          logger.error(
            { err: errorSummary(err), category, accountId },
            'auth email delivery failed',
          );
          if (mailDispatch === 'await') throw err;
        },
      );
    if (mailDispatch === 'await') {
      await job;
      return;
    }
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };

  const toPublic = (a: AccountRecord): PublicAccount => ({
    id: a.id,
    email: a.email,
    emailVerified: a.emailVerifiedAt !== null,
    emailVerifiedAt: a.emailVerifiedAt,
    hasPassword: a.passwordHash !== null,
    mfaEnabled: a.mfaEnabledAt !== null,
    disabled: a.disabledAt !== null,
    lockedUntil: a.lockedUntil !== null && a.lockedUntil > clock.now() ? a.lockedUntil : null,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt,
  });

  const toSessionInfo = (s: SessionRecord, currentId?: string): SessionInfo => ({
    id: s.id,
    accountId: s.accountId,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    idleExpiresAt: Math.min(s.expiresAt, s.lastSeenAt + session.idleTimeoutMs),
    ip: s.ip,
    userAgent: s.userAgent,
    authMethod: s.authMethod,
    mfaVerified: s.mfaVerified,
    ...(currentId !== undefined ? { current: s.id === currentId } : {}),
  });

  const amrFor = (s: SessionRecord): string[] => {
    const base =
      s.authMethod === 'password'
        ? ['pwd']
        : s.authMethod === 'oidc'
          ? ['fed']
          : s.authMethod === 'webauthn'
            ? ['hwk']
            : [];
    if (s.mfaVerified && s.authMethod !== 'webauthn') base.push('otp');
    if (s.mfaVerified) base.push('mfa');
    return base;
  };

  const consumeLimit = async (limiter: RateLimiterLike, key: string) => {
    let decision: Awaited<ReturnType<RateLimiterLike['consume']>>;
    try {
      decision = await limiter.consume(key);
    } catch (err) {
      // A failing shared limiter must not disable authentication; lockout still applies.
      logger.error({ err: errorSummary(err) }, 'auth rate limiter failed');
      return;
    }
    if (!decision.allowed) {
      const retryMs = decision.retryAfterMs ?? Math.max(0, decision.resetAt - clock.now());
      throw new AuthError('AUTH_RATE_LIMITED', {
        retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
      });
    }
  };

  const requireAccount = async (accountId: string): Promise<AccountRecord> => {
    const account = isSafeId(accountId) ? await store.getAccountById(accountId) : undefined;
    if (!account) throw new AuthError('AUTH_ACCOUNT_NOT_FOUND');
    return account;
  };

  const newAccountRecord = (
    id: string,
    email: string,
    passwordHash: string | null,
    verifiedAt: number | null,
  ): AccountRecord => {
    const now = clock.now();
    return {
      id,
      email,
      emailVerifiedAt: verifiedAt,
      passwordHash,
      passwordChangedAt: passwordHash ? now : null,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      lockoutLevel: 0,
      disabledAt: null,
      totpSecret: null,
      totpPendingSecret: null,
      totpLastStep: null,
      mfaEnabledAt: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
  };

  const createOneTime = async (
    purpose: OneTimeTokenPurpose,
    accountId: string | null,
    ttlMs: number,
    data: Record<string, unknown> | null = null,
  ): Promise<{ token: string; expiresAt: number }> => {
    const token = randomToken(32);
    const now = clock.now();
    const expiresAt = now + ttlMs;
    await store.createOneTimeToken({
      id: generateId(),
      tokenHash: sha256Hex(token),
      purpose,
      accountId,
      data,
      attempts: 0,
      createdAt: now,
      expiresAt,
      usedAt: null,
    });
    return { token, expiresAt };
  };

  const revokeSessions = async (sessionIds: string[]) => {
    if (sessionIds.length > 0) await store.revokeRefreshTokensBySessions(sessionIds, clock.now());
  };

  const endSession = async (s: SessionRecord) => {
    await store.deleteSession(s.id);
    await revokeSessions([s.id]);
  };

  const issueTokenPair = async (s: SessionRecord, familyId?: string): Promise<TokenPair> => {
    if (!accessTokens)
      throw new AuthError('AUTH_FEATURE_DISABLED', { message: 'Token issuance is not configured' });
    const now = clock.now();
    const refreshToken = randomToken(32);
    const refreshExpiresAt = Math.min(now + refreshTtl, s.expiresAt);
    await store.createRefreshToken({
      id: generateId(),
      familyId: familyId ?? generateId(),
      accountId: s.accountId,
      sessionId: s.id,
      tokenHash: sha256Hex(refreshToken),
      createdAt: now,
      expiresAt: refreshExpiresAt,
      usedAt: null,
      revokedAt: null,
    });
    const accessToken = await accessTokens.sign({
      accountId: s.accountId,
      sessionId: s.id,
      amr: amrFor(s),
      jti: randomUUID(),
      nowMs: now,
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: Math.floor(accessTokens.ttlMs / 1000),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  };

  const createSession = async (
    account: AccountRecord,
    method: AuthMethod,
    mfaVerified: boolean,
    ctx: RequestContext | undefined,
  ): Promise<{ token: string; record: SessionRecord }> => {
    const now = clock.now();
    const token = randomToken(32);
    const record: SessionRecord = {
      id: generateId(),
      accountId: account.id,
      tokenHash: sha256Hex(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + session.absoluteTimeoutMs,
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ? ctx.userAgent.slice(0, 512) : null,
      authMethod: method,
      mfaVerified,
    };
    await store.createSession(record);
    return { token, record };
  };

  const completeSignIn = async (
    account: AccountRecord,
    method: AuthMethod,
    mfaVerified: boolean,
    ctx: RequestContext | undefined,
    currentSessionToken: string | undefined,
    wantTokens: boolean | undefined,
  ): Promise<AuthenticatedResult> => {
    if (wantTokens && !accessTokens) {
      throw new AuthError('AUTH_FEATURE_DISABLED', { message: 'Token issuance is not configured' });
    }
    if (currentSessionToken && isTokenString(currentSessionToken)) {
      const previous = await store.getSessionByTokenHash(sha256Hex(currentSessionToken));
      if (previous) await endSession(previous);
    }
    const { token, record } = await createSession(account, method, mfaVerified, ctx);
    const now = clock.now();
    const updated =
      (await store.updateAccount(account.id, { lastLoginAt: now, updatedAt: now })) ?? account;
    const result: AuthenticatedResult = {
      status: 'authenticated',
      account: toPublic(updated),
      session: toSessionInfo(record),
      sessionToken: token,
    };
    if (wantTokens) result.tokens = await issueTokenPair(record);
    await audit('auth.login.succeeded', 'success', ctx, account.id, {
      method,
      mfa: mfaVerified,
      sessionId: record.id,
    });
    return result;
  };

  const startMfaChallenge = async (
    account: AccountRecord,
    method: AuthMethod,
    ctx: RequestContext | undefined,
  ): Promise<MfaRequiredResult> => {
    const { token, expiresAt } = await createOneTime(
      'mfa-challenge',
      account.id,
      mfaConfig.challengeTtlMs,
      { method },
    );
    await audit('auth.login.mfa_required', 'success', ctx, account.id, { method });
    const methods: MfaRequiredResult['methods'] = ['totp'];
    if ((await store.countUnusedRecoveryCodes(account.id)) > 0) methods.push('recovery_code');
    return { status: 'mfa_required', challengeToken: token, expiresAt, methods };
  };

  const lockDuration = (level: number) =>
    Math.min(lockout.maxDurationMs, Math.round(lockout.baseDurationMs * lockout.factor ** level));

  /** Records a failed credential check and applies the lockout policy. */
  const registerFailure = async (
    account: AccountRecord,
    ctx: RequestContext | undefined,
    reason: string,
  ) => {
    const now = clock.now();
    const count = await store.incrementFailedLogins(account.id, now);
    await audit('auth.login.failed', 'failure', ctx, account.id, { reason, email: account.email });
    if (!lockout.enabled || count < lockout.maxFailures) return;
    const previousLockEnded = account.lockedUntil;
    const level =
      previousLockEnded !== null && now - previousLockEnded > lockout.levelResetMs
        ? 0
        : account.lockoutLevel;
    const duration = lockDuration(level);
    const lockedUntil = now + duration;
    await store.updateAccount(account.id, {
      lockedUntil,
      lockoutLevel: level + 1,
      failedLoginCount: 0,
      updatedAt: now,
    });
    await audit('auth.lockout', 'denied', ctx, account.id, {
      lockedUntil,
      level: level + 1,
      durationMs: duration,
    });
    if (lockout.notify) {
      await sendMail(
        account.email,
        templates.lockout({ appName, email: account.email, lockedUntil: new Date(lockedUntil) }),
        'auth.lockout',
        account.id,
      );
    }
  };

  const verifyProof = async (
    account: AccountRecord,
    proof: ReauthProof,
    ctx: RequestContext | undefined,
  ) => {
    await consumeLimit(limiters.verification, `auth:reauth:${account.id}`);
    if ('password' in proof) {
      if (!account.passwordHash || !isPlausiblePassword(proof.password, policy.maxLength)) {
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      if (!(await hasher.verify(account.passwordHash, proof.password))) {
        await audit('auth.reauth.failed', 'failure', ctx, account.id, { method: 'password' });
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      return;
    }
    if ('totp' in proof) {
      if (!(await checkTotp(account, proof.totp))) {
        await audit('auth.reauth.failed', 'failure', ctx, account.id, { method: 'totp' });
        throw new AuthError('AUTH_MFA_INVALID_CODE');
      }
      return;
    }
    throw new AuthError('AUTH_VALIDATION_FAILED', {
      message: 'A password or verification code is required',
    });
  };

  const requireMfaConfigured = () => {
    if (!encryptor || !totpOptions) throw new AuthError('AUTH_MFA_NOT_CONFIGURED');
    return { encryptor, totpOptions };
  };

  const checkTotp = async (account: AccountRecord, code: unknown): Promise<boolean> => {
    const { encryptor: enc, totpOptions: opts } = requireMfaConfigured();
    if (!account.totpSecret || typeof code !== 'string' || code.length > 16) return false;
    let secret: Buffer;
    try {
      secret = base32Decode(enc.decrypt(account.totpSecret, account.id));
    } catch (err) {
      logger.error(
        { err: errorSummary(err), accountId: account.id },
        'auth could not decrypt TOTP secret',
      );
      return false;
    }
    const step = verifyTotp(secret, code, clock.now(), opts);
    if (step === null) return false;
    return store.advanceTotpStep(account.id, step);
  };

  const issueRecoveryCodes = async (accountId: string): Promise<string[]> => {
    const codes = generateRecoveryCodes(mfaConfig.recoveryCodeCount);
    const now = clock.now();
    await store.replaceRecoveryCodes(
      accountId,
      codes.map((c) => ({
        id: generateId(),
        accountId,
        codeHash: sha256Hex(normalizeRecoveryCode(c)),
        createdAt: now,
        usedAt: null,
      })),
    );
    return codes;
  };

  const rotate = async (current: SessionRecord, ctx: RequestContext | undefined) => {
    const account = await requireAccount(current.accountId);
    await endSession(current);
    const now = clock.now();
    const token = randomToken(32);
    const record: SessionRecord = {
      ...current,
      id: generateId(),
      tokenHash: sha256Hex(token),
      lastSeenAt: now,
      ip: ctx?.ip ?? current.ip,
    };
    await store.createSession(record);
    await audit('auth.session.rotated', 'success', ctx, account.id, {
      previousSessionId: current.id,
      sessionId: record.id,
    });
    return { sessionToken: token, session: toSessionInfo(record) };
  };

  const sessionFromToken = async (sessionToken: string | undefined) => {
    if (!isTokenString(sessionToken)) return undefined;
    return store.getSessionByTokenHash(sha256Hex(sessionToken));
  };

  const validateSession = async (
    s: SessionRecord,
    ctx: RequestContext | undefined,
  ): Promise<SessionAuth> => {
    const now = clock.now();
    if (now >= s.expiresAt || now - s.lastSeenAt >= session.idleTimeoutMs) {
      await endSession(s);
      await audit('auth.session.expired', 'failure', ctx, s.accountId, { sessionId: s.id });
      throw new AuthError('AUTH_SESSION_EXPIRED');
    }
    const account = await store.getAccountById(s.accountId);
    if (!account || account.disabledAt !== null) {
      await endSession(s);
      throw new AuthError('AUTH_UNAUTHENTICATED');
    }
    let current = s;
    if (now - s.lastSeenAt >= session.touchIntervalMs) {
      await store.touchSession(s.id, now, ctx?.ip ?? null);
      current = { ...s, lastSeenAt: now, ip: ctx?.ip ?? s.ip };
    }
    return { account: toPublic(account), session: toSessionInfo(current) };
  };

  const internals: AuthInternals = {
    store,
    clock,
    generateId,
    logger,
    appName,
    recordAudit,
    context,
  };

  // ---------- public API ----------

  const auth: Auth = {
    internals,
    config: {
      session,
      tokensEnabled: accessTokens !== undefined,
      mfaEnabled: encryptor !== undefined,
      hasMailer: mailer !== undefined,
      passwordPolicy: { minLength: policy.minLength, maxLength: policy.maxLength },
    },

    async register({ email, password, id, context: ctx }) {
      const normalized = requireEmail(email);
      await policy.check(password);
      if (id !== undefined && !isSafeId(id)) {
        throw new AuthError('AUTH_VALIDATION_FAILED', {
          message: 'Invalid account id',
          details: [{ field: 'id' }],
        });
      }
      const passwordHash = await hasher.hash(password);
      const record = newAccountRecord(id ?? generateId(), normalized, passwordHash, null);
      if (!(await store.createAccount(record))) {
        await audit('auth.register', 'failure', ctx, undefined, { reason: 'email_taken' });
        throw new AuthError('AUTH_EMAIL_TAKEN');
      }
      await audit('auth.register', 'success', ctx, record.id, { method: 'password' });
      const result: { account: PublicAccount; verificationToken?: string } = {
        account: toPublic(record),
      };
      if (sendOnRegister) {
        const sent = await auth.sendEmailVerification(record.id, ctx);
        if (sent.token) result.verificationToken = sent.token;
      }
      return result;
    },

    async createAccount({ email, emailVerified, id, context: ctx }) {
      const normalized = requireEmail(email);
      if (id !== undefined && !isSafeId(id)) {
        throw new AuthError('AUTH_VALIDATION_FAILED', {
          message: 'Invalid account id',
          details: [{ field: 'id' }],
        });
      }
      const record = newAccountRecord(
        id ?? generateId(),
        normalized,
        null,
        emailVerified ? clock.now() : null,
      );
      if (!(await store.createAccount(record))) throw new AuthError('AUTH_EMAIL_TAKEN');
      await audit('auth.register', 'success', ctx, record.id, { method: 'passwordless' });
      return toPublic(record);
    },

    async login({ email, password, context: ctx, currentSessionToken, issueTokens }) {
      const normalized = normalizeEmail(email);
      if (!normalized || !isPlausiblePassword(password, policy.maxLength)) {
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      if (ctx?.ip) await consumeLimit(limiters.loginIp, `auth:login:ip:${ctx.ip}`);
      try {
        await consumeLimit(limiters.loginEmail, `auth:login:email:${normalized}`);
      } catch (err) {
        await audit('auth.login.failed', 'denied', ctx, undefined, {
          reason: 'rate_limited',
          email: normalized,
        });
        throw err;
      }

      const account = await store.getAccountByEmail(normalized);
      if (!account || account.passwordHash === null) {
        await dummyVerify(password);
        await audit('auth.login.failed', 'failure', ctx, account?.id, {
          reason: account ? 'no_password' : 'unknown_account',
          email: normalized,
        });
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }

      const now = clock.now();
      const locked = account.lockedUntil !== null && account.lockedUntil > now;
      const valid = await hasher.verify(account.passwordHash, password);

      if (locked) {
        await audit('auth.login.failed', 'denied', ctx, account.id, {
          reason: 'locked',
          email: normalized,
        });
        if (lockout.reveal === 'always' || (lockout.reveal === 'after-valid-password' && valid)) {
          const retryAfterSeconds = Math.ceil(((account.lockedUntil as number) - now) / 1000);
          throw new AuthError('AUTH_ACCOUNT_LOCKED', { retryAfterSeconds });
        }
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      if (account.disabledAt !== null) {
        await audit('auth.login.failed', 'denied', ctx, account.id, {
          reason: 'disabled',
          email: normalized,
        });
        if (lockout.reveal === 'always' || (lockout.reveal === 'after-valid-password' && valid)) {
          throw new AuthError('AUTH_ACCOUNT_DISABLED');
        }
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      if (!valid) {
        await registerFailure(account, ctx, 'invalid_password');
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      if (requireVerified && account.emailVerifiedAt === null) {
        await audit('auth.login.failed', 'denied', ctx, account.id, {
          reason: 'email_not_verified',
        });
        throw new AuthError('AUTH_EMAIL_NOT_VERIFIED');
      }

      const patch: Partial<AccountRecord> = {};
      if (
        account.failedLoginCount !== 0 ||
        account.lockedUntil !== null ||
        account.lockoutLevel !== 0
      ) {
        patch.failedLoginCount = 0;
        patch.lockedUntil = null;
        patch.lockoutLevel = 0;
      }
      if (hasher.needsRehash(account.passwordHash)) {
        patch.passwordHash = await hasher.hash(password);
        logger.info({ accountId: account.id }, 'auth password hash upgraded');
      }
      let current = account;
      if (Object.keys(patch).length > 0) {
        current =
          (await store.updateAccount(account.id, { ...patch, updatedAt: clock.now() })) ?? account;
      }
      if (current.mfaEnabledAt !== null) return startMfaChallenge(current, 'password', ctx);
      return completeSignIn(current, 'password', false, ctx, currentSessionToken, issueTokens);
    },

    async completeMfaChallenge({
      challengeToken,
      code,
      recoveryCode,
      context: ctx,
      currentSessionToken,
      issueTokens,
    }) {
      if (!isTokenString(challengeToken)) throw new AuthError('AUTH_INVALID_TOKEN');
      const hash = sha256Hex(challengeToken);
      const challenge = await store.getOneTimeToken(hash, 'mfa-challenge');
      if (!challenge || challenge.expiresAt <= clock.now() || !challenge.accountId) {
        throw new AuthError('AUTH_INVALID_TOKEN');
      }
      const account = await store.getAccountById(challenge.accountId);
      if (!account || account.disabledAt !== null || account.mfaEnabledAt === null) {
        await store.consumeOneTimeToken(hash, 'mfa-challenge', clock.now());
        throw new AuthError('AUTH_INVALID_TOKEN');
      }
      await consumeLimit(limiters.verification, `auth:mfa:${account.id}`);
      const attempts = await store.incrementOneTimeTokenAttempts(challenge.id);
      if (attempts > mfaConfig.maxChallengeAttempts) {
        await store.consumeOneTimeToken(hash, 'mfa-challenge', clock.now());
        throw new AuthError('AUTH_INVALID_TOKEN');
      }
      let ok = false;
      let usedRecovery = false;
      if (typeof code === 'string' && code.length > 0) {
        ok = await checkTotp(account, code);
      } else if (
        typeof recoveryCode === 'string' &&
        recoveryCode.length > 0 &&
        recoveryCode.length <= 64
      ) {
        requireMfaConfigured();
        ok = await store.consumeRecoveryCode(
          account.id,
          sha256Hex(normalizeRecoveryCode(recoveryCode)),
          clock.now(),
        );
        usedRecovery = ok;
      } else {
        throw new AuthError('AUTH_VALIDATION_FAILED', {
          message: 'A verification code or recovery code is required',
        });
      }
      if (!ok) {
        await audit('auth.mfa.failed', 'failure', ctx, account.id, {
          method: recoveryCode ? 'recovery_code' : 'totp',
        });
        await registerFailure(account, ctx, 'invalid_mfa_code');
        throw new AuthError('AUTH_MFA_INVALID_CODE');
      }
      const consumed = await store.consumeOneTimeToken(hash, 'mfa-challenge', clock.now());
      if (!consumed) throw new AuthError('AUTH_INVALID_TOKEN');
      if (usedRecovery) {
        const remaining = await store.countUnusedRecoveryCodes(account.id);
        await audit('auth.mfa.recovery_code_used', 'success', ctx, account.id, { remaining });
      }
      const method = (challenge.data?.method as AuthMethod | undefined) ?? 'password';
      await audit('auth.mfa.succeeded', 'success', ctx, account.id, {
        method: usedRecovery ? 'recovery_code' : 'totp',
      });
      const fresh =
        (await store.updateAccount(account.id, { failedLoginCount: 0, updatedAt: clock.now() })) ??
        account;
      return completeSignIn(fresh, method, true, ctx, currentSessionToken, issueTokens);
    },

    async signIn(
      accountId,
      { method, context: ctx, mfaVerified, enforceMfa, currentSessionToken, issueTokens },
    ) {
      const account = await requireAccount(accountId);
      if (account.disabledAt !== null) {
        await audit('auth.login.failed', 'denied', ctx, account.id, { reason: 'disabled', method });
        throw new AuthError('AUTH_ACCOUNT_DISABLED');
      }
      if (account.lockedUntil !== null && account.lockedUntil > clock.now()) {
        await audit('auth.login.failed', 'denied', ctx, account.id, { reason: 'locked', method });
        throw new AuthError('AUTH_ACCOUNT_LOCKED', {
          retryAfterSeconds: Math.ceil((account.lockedUntil - clock.now()) / 1000),
        });
      }
      if (!mfaVerified && (enforceMfa ?? true) && account.mfaEnabledAt !== null) {
        return startMfaChallenge(account, method, ctx);
      }
      return completeSignIn(
        account,
        method,
        mfaVerified ?? false,
        ctx,
        currentSessionToken,
        issueTokens,
      );
    },

    async authenticateSession(sessionToken, ctx) {
      const s = await sessionFromToken(sessionToken);
      if (!s) throw new AuthError('AUTH_UNAUTHENTICATED');
      return validateSession(s, ctx);
    },

    async authenticateAccessToken(accessToken, ctx) {
      if (!accessTokens) throw new AuthError('AUTH_UNAUTHENTICATED');
      if (typeof accessToken !== 'string' || accessToken.length > 4096)
        throw new AuthError('AUTH_INVALID_TOKEN');
      const claims = await accessTokens.verify(accessToken, clock.now());
      const s = await store.getSession(claims.sid);
      if (!s || s.accountId !== claims.sub) throw new AuthError('AUTH_INVALID_TOKEN');
      const result = await validateSession(s, ctx);
      return { ...result, claims };
    },

    async logout(sessionToken, ctx) {
      const s = await sessionFromToken(sessionToken);
      if (!s) return;
      await endSession(s);
      await audit('auth.logout', 'success', ctx, s.accountId, { sessionId: s.id });
    },

    async refresh(refreshToken, ctx) {
      if (!accessTokens)
        throw new AuthError('AUTH_FEATURE_DISABLED', {
          message: 'Token issuance is not configured',
        });
      if (!isTokenString(refreshToken)) throw new AuthError('AUTH_INVALID_TOKEN');
      const record = await store.getRefreshTokenByHash(sha256Hex(refreshToken));
      if (!record || record.revokedAt !== null) throw new AuthError('AUTH_INVALID_TOKEN');
      const now = clock.now();
      const reuse = async () => {
        await store.revokeRefreshFamily(record.familyId, now);
        const s = await store.getSession(record.sessionId);
        if (s) await endSession(s);
        await audit('auth.refresh.reuse_detected', 'denied', ctx, record.accountId, {
          familyId: record.familyId,
          sessionId: record.sessionId,
        });
        logger.warn(
          { accountId: record.accountId, familyId: record.familyId },
          'auth refresh token reuse detected',
        );
        throw new AuthError('AUTH_REFRESH_TOKEN_REUSED');
      };
      if (record.usedAt !== null) return reuse();
      if (record.expiresAt <= now) throw new AuthError('AUTH_INVALID_TOKEN');
      if (!(await store.markRefreshTokenUsed(record.id, now))) return reuse();
      const s = await store.getSession(record.sessionId);
      if (!s) {
        await store.revokeRefreshFamily(record.familyId, now);
        throw new AuthError('AUTH_SESSION_EXPIRED');
      }
      const { account, session: info } = await validateSession(s, ctx);
      if (now - s.lastSeenAt < session.touchIntervalMs) {
        await store.touchSession(s.id, now, ctx?.ip ?? null);
      }
      const tokens = await issueTokenPair(s, record.familyId);
      await audit('auth.refresh.succeeded', 'success', ctx, account.id, {
        sessionId: s.id,
        familyId: record.familyId,
      });
      return { account, session: { ...info, lastSeenAt: now }, tokens };
    },

    async issueTokens(sessionToken, ctx) {
      const s = await sessionFromToken(sessionToken);
      if (!s) throw new AuthError('AUTH_UNAUTHENTICATED');
      await validateSession(s, ctx);
      return issueTokenPair(s);
    },

    async rotateSession(sessionToken, ctx) {
      const s = await sessionFromToken(sessionToken);
      if (!s) throw new AuthError('AUTH_UNAUTHENTICATED');
      await validateSession(s, ctx);
      return rotate(s, ctx);
    },

    async listSessions(accountId, currentSessionId) {
      const now = clock.now();
      const sessions = await store.listSessions(accountId);
      return sessions
        .filter((s) => s.expiresAt > now && now - s.lastSeenAt < session.idleTimeoutMs)
        .map((s) => toSessionInfo(s, currentSessionId));
    },

    async revokeSession(accountId, sessionId, ctx) {
      if (!isSafeId(sessionId)) return false;
      const s = await store.getSession(sessionId);
      // Scoped to the account so one user can never revoke another user's session.
      if (!s || s.accountId !== accountId) return false;
      await endSession(s);
      await audit('auth.session.revoked', 'success', ctx, accountId, { sessionId });
      return true;
    },

    async revokeAllSessions(accountId, opts = {}) {
      const ids = await store.deleteSessionsByAccount(accountId, opts.exceptSessionId);
      await revokeSessions(ids);
      await audit('auth.session.revoked', 'success', opts.context, accountId, {
        count: ids.length,
        scope: opts.exceptSessionId ? 'others' : 'all',
      });
      return ids.length;
    },

    async changePassword({
      accountId,
      currentPassword,
      newPassword,
      currentSessionToken,
      currentSessionId,
      context: ctx,
    }) {
      const account = await requireAccount(accountId);
      if (!account.passwordHash) throw new AuthError('AUTH_PASSWORD_NOT_SET');
      await verifyProof(account, { password: currentPassword }, ctx);
      await policy.check(newPassword);
      const now = clock.now();
      await store.updateAccount(account.id, {
        passwordHash: await hasher.hash(newPassword),
        passwordChangedAt: now,
        updatedAt: now,
      });
      await store.deleteOneTimeTokens(account.id, 'password-reset');
      const current = await sessionFromToken(currentSessionToken);
      let currentId = current && current.accountId === account.id ? current.id : undefined;
      if (currentId === undefined && currentSessionId !== undefined && isSafeId(currentSessionId)) {
        const kept = await store.getSession(currentSessionId);
        if (kept && kept.accountId === account.id) currentId = kept.id;
      }
      if (revokeOnPasswordChange) {
        const ids = await store.deleteSessionsByAccount(account.id, currentId);
        await revokeSessions(ids);
      }
      await audit('auth.password.changed', 'success', ctx, account.id, {
        revokedOtherSessions: revokeOnPasswordChange,
      });
      if (current && currentId) return rotate(current, ctx);
      return {};
    },

    async requestPasswordReset({ email, context: ctx }) {
      const normalized = requireEmail(email);
      if (ctx?.ip) await consumeLimit(limiters.resetIp, `auth:reset:ip:${ctx.ip}`);
      await consumeLimit(limiters.resetEmail, `auth:reset:email:${normalized}`);
      const account = await store.getAccountByEmail(normalized);
      // Equalise work between known and unknown addresses; the response never differs.
      const token = randomToken(32);
      const tokenHash = sha256Hex(token);
      if (!account || account.disabledAt !== null) {
        await audit('auth.password.reset.requested', 'failure', ctx, account?.id, {
          reason: account ? 'disabled' : 'unknown_account',
          email: normalized,
        });
        return {};
      }
      await store.deleteOneTimeTokens(account.id, 'password-reset');
      const now = clock.now();
      await store.createOneTimeToken({
        id: generateId(),
        tokenHash,
        purpose: 'password-reset',
        accountId: account.id,
        data: null,
        attempts: 0,
        createdAt: now,
        expiresAt: now + resetTtl,
        usedAt: null,
      });
      await audit('auth.password.reset.requested', 'success', ctx, account.id, {});
      if (mailer && options.links?.passwordReset) {
        const url = buildLink(options.links.passwordReset, token);
        await sendMail(
          account.email,
          templates.passwordReset({
            appName,
            email: account.email,
            url,
            expiresInMinutes: Math.round(resetTtl / 60_000),
          }),
          'auth.password-reset',
          account.id,
        );
        return {};
      }
      return { token };
    },

    async resetPassword({ token, newPassword, context: ctx }) {
      await policy.check(newPassword);
      if (!isTokenString(token)) throw new AuthError('AUTH_INVALID_TOKEN');
      const record = await store.consumeOneTimeToken(
        sha256Hex(token),
        'password-reset',
        clock.now(),
      );
      if (!record?.accountId) throw new AuthError('AUTH_INVALID_TOKEN');
      const account = await store.getAccountById(record.accountId);
      if (!account || account.disabledAt !== null) throw new AuthError('AUTH_INVALID_TOKEN');
      const now = clock.now();
      await store.updateAccount(account.id, {
        passwordHash: await hasher.hash(newPassword),
        passwordChangedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
        lockoutLevel: 0,
        // Completing a reset proves control of the mailbox.
        emailVerifiedAt: account.emailVerifiedAt ?? now,
        updatedAt: now,
      });
      await store.deleteOneTimeTokens(account.id, 'password-reset');
      if (resetRevokes) {
        const ids = await store.deleteSessionsByAccount(account.id);
        await revokeSessions(ids);
      }
      await audit('auth.password.reset.completed', 'success', ctx, account.id, {
        revokedSessions: resetRevokes,
      });
      return { accountId: account.id };
    },

    async sendEmailVerification(accountId, ctx) {
      const account = await requireAccount(accountId);
      if (account.emailVerifiedAt !== null) return { alreadyVerified: true };
      const latest = await store.getLatestOneTimeTokenCreatedAt(account.id, 'email-verification');
      const now = clock.now();
      if (latest !== undefined && now - latest < resendInterval) {
        throw new AuthError('AUTH_RATE_LIMITED', {
          retryAfterSeconds: Math.max(1, Math.ceil((latest + resendInterval - now) / 1000)),
        });
      }
      await store.deleteOneTimeTokens(account.id, 'email-verification');
      const { token } = await createOneTime('email-verification', account.id, verifyTtl, {
        email: account.email,
      });
      await audit('auth.email.verification.sent', 'success', ctx, account.id, {});
      if (mailer && options.links?.emailVerification) {
        const url = buildLink(options.links.emailVerification, token);
        await sendMail(
          account.email,
          templates.emailVerification({
            appName,
            email: account.email,
            url,
            expiresInMinutes: Math.round(verifyTtl / 60_000),
          }),
          'auth.email-verification',
          account.id,
        );
        return {};
      }
      return { token };
    },

    async verifyEmail({ token, context: ctx }) {
      if (!isTokenString(token)) throw new AuthError('AUTH_INVALID_TOKEN');
      const hash = sha256Hex(token);
      const now = clock.now();
      const record =
        (await store.consumeOneTimeToken(hash, 'email-verification', now)) ??
        (await store.consumeOneTimeToken(hash, 'email-change', now));
      if (!record?.accountId) throw new AuthError('AUTH_INVALID_TOKEN');
      const account = await store.getAccountById(record.accountId);
      const email = typeof record.data?.email === 'string' ? record.data.email : undefined;
      if (!account || !email) throw new AuthError('AUTH_INVALID_TOKEN');
      if (record.purpose === 'email-verification') {
        // The token is only valid for the address it was issued for.
        if (email !== account.email) throw new AuthError('AUTH_INVALID_TOKEN');
        await store.updateAccount(account.id, { emailVerifiedAt: now, updatedAt: now });
        await audit('auth.email.verified', 'success', ctx, account.id, {});
        return { accountId: account.id, email };
      }
      const other = await store.getAccountByEmail(email);
      if (other && other.id !== account.id) throw new AuthError('AUTH_EMAIL_TAKEN');
      await store.updateAccount(account.id, { email, emailVerifiedAt: now, updatedAt: now });
      await store.deleteOneTimeTokens(account.id, 'password-reset');
      await store.deleteOneTimeTokens(account.id, 'email-verification');
      await audit('auth.email.changed', 'success', ctx, account.id, {});
      await audit('auth.email.verified', 'success', ctx, account.id, {});
      return { accountId: account.id, email };
    },

    async changeEmail({ accountId, newEmail, currentPassword, context: ctx }) {
      const account = await requireAccount(accountId);
      const normalized = requireEmail(newEmail, 'newEmail');
      if (account.passwordHash) {
        if (typeof currentPassword !== 'string') {
          throw new AuthError('AUTH_VALIDATION_FAILED', {
            message: 'The current password is required',
            details: [{ field: 'currentPassword', message: 'is required' }],
          });
        }
        await verifyProof(account, { password: currentPassword }, ctx);
      }
      if (normalized === account.email) {
        throw new AuthError('AUTH_VALIDATION_FAILED', {
          message: 'The new email matches the current email',
        });
      }
      if (await store.getAccountByEmail(normalized)) throw new AuthError('AUTH_EMAIL_TAKEN');
      await store.deleteOneTimeTokens(account.id, 'email-change');
      const { token } = await createOneTime('email-change', account.id, verifyTtl, {
        email: normalized,
      });
      await audit('auth.email.change.requested', 'success', ctx, account.id, {});
      if (mailer && options.links?.emailVerification) {
        const url = buildLink(options.links.emailVerification, token);
        const minutes = Math.round(verifyTtl / 60_000);
        await sendMail(
          normalized,
          templates.emailChange({ appName, email: normalized, url, expiresInMinutes: minutes }),
          'auth.email-verification',
          account.id,
        );
        await sendMail(
          account.email,
          templates.emailChangeNotice({ appName, email: account.email, newEmail: normalized }),
          'auth.email-change',
          account.id,
        );
        return {};
      }
      return { token };
    },

    async getAccount(accountId) {
      if (!isSafeId(accountId)) return undefined;
      const a = await store.getAccountById(accountId);
      return a ? toPublic(a) : undefined;
    },

    async getAccountByEmail(email) {
      const normalized = normalizeEmail(email);
      if (!normalized) return undefined;
      const a = await store.getAccountByEmail(normalized);
      return a ? toPublic(a) : undefined;
    },

    async unlockAccount(accountId, opts = {}) {
      await requireAccount(accountId);
      await store.updateAccount(accountId, {
        lockedUntil: null,
        failedLoginCount: 0,
        lockoutLevel: 0,
        updatedAt: clock.now(),
      });
      await recordAudit({
        action: 'auth.account.unlocked',
        outcome: 'success',
        category: 'admin',
        ...context(opts.context, opts.actorId),
        resource: { type: 'auth.account', id: accountId },
      });
    },

    async disableAccount(accountId, opts = {}) {
      await requireAccount(accountId);
      const now = clock.now();
      await store.updateAccount(accountId, { disabledAt: now, updatedAt: now });
      const ids = await store.deleteSessionsByAccount(accountId);
      await revokeSessions(ids);
      await recordAudit({
        action: 'auth.account.disabled',
        outcome: 'success',
        category: 'admin',
        ...context(opts.context, opts.actorId),
        resource: { type: 'auth.account', id: accountId },
        metadata: { revokedSessions: ids.length },
      });
    },

    async enableAccount(accountId, opts = {}) {
      await requireAccount(accountId);
      await store.updateAccount(accountId, { disabledAt: null, updatedAt: clock.now() });
      await recordAudit({
        action: 'auth.account.enabled',
        outcome: 'success',
        category: 'admin',
        ...context(opts.context, opts.actorId),
        resource: { type: 'auth.account', id: accountId },
      });
    },

    async deleteAccount(accountId, opts = {}) {
      if (!isSafeId(accountId)) return false;
      const deleted = await store.deleteAccount(accountId);
      if (deleted) {
        await recordAudit({
          action: 'auth.account.deleted',
          outcome: 'success',
          category: 'admin',
          ...context(opts.context, opts.actorId),
          resource: { type: 'auth.account', id: accountId },
        });
      }
      return deleted;
    },

    async beginTotpEnrollment(accountId) {
      const { encryptor: enc, totpOptions: opts } = requireMfaConfigured();
      const account = await requireAccount(accountId);
      if (account.mfaEnabledAt !== null) throw new AuthError('AUTH_MFA_ALREADY_ENABLED');
      const secret = generateTotpSecret(opts.algorithm);
      const encoded = base32Encode(secret);
      await store.updateAccount(account.id, {
        totpPendingSecret: enc.encrypt(encoded, account.id),
        updatedAt: clock.now(),
      });
      return {
        secret: encoded,
        otpauthUri: buildOtpauthUri({
          secret,
          accountName: account.email,
          issuer: mfaConfig.issuer,
          options: opts,
        }),
      };
    },

    async confirmTotpEnrollment(accountId, code, opts = {}) {
      const { encryptor: enc, totpOptions: topts } = requireMfaConfigured();
      const account = await requireAccount(accountId);
      if (account.mfaEnabledAt !== null) throw new AuthError('AUTH_MFA_ALREADY_ENABLED');
      if (!account.totpPendingSecret)
        throw new AuthError('AUTH_MFA_NOT_ENABLED', { message: 'Start TOTP enrolment first' });
      await consumeLimit(limiters.verification, `auth:mfa:${account.id}`);
      const encoded = enc.decrypt(account.totpPendingSecret, account.id);
      const step =
        typeof code === 'string'
          ? verifyTotp(base32Decode(encoded), code, clock.now(), topts)
          : null;
      if (step === null) {
        await audit('auth.mfa.enrollment.failed', 'failure', opts.context, account.id, {});
        throw new AuthError('AUTH_MFA_INVALID_CODE');
      }
      const now = clock.now();
      await store.updateAccount(account.id, {
        totpSecret: enc.encrypt(encoded, account.id),
        totpPendingSecret: null,
        totpLastStep: step,
        mfaEnabledAt: now,
        updatedAt: now,
      });
      const recoveryCodes = await issueRecoveryCodes(account.id);
      await audit('auth.mfa.enabled', 'success', opts.context, account.id, { method: 'totp' });
      const current = await sessionFromToken(opts.currentSessionToken);
      if (current && current.accountId === account.id) {
        const rotated = await rotate({ ...current, mfaVerified: true }, opts.context);
        return { recoveryCodes, ...rotated };
      }
      return { recoveryCodes };
    },

    async disableTotp(accountId, proof, ctx) {
      requireMfaConfigured();
      const account = await requireAccount(accountId);
      if (account.mfaEnabledAt === null) throw new AuthError('AUTH_MFA_NOT_ENABLED');
      await verifyProof(account, proof, ctx);
      await store.updateAccount(account.id, {
        totpSecret: null,
        totpPendingSecret: null,
        totpLastStep: null,
        mfaEnabledAt: null,
        updatedAt: clock.now(),
      });
      await store.replaceRecoveryCodes(account.id, []);
      await audit('auth.mfa.disabled', 'success', ctx, account.id, { method: 'totp' });
    },

    async regenerateRecoveryCodes(accountId, proof, ctx) {
      requireMfaConfigured();
      const account = await requireAccount(accountId);
      if (account.mfaEnabledAt === null) throw new AuthError('AUTH_MFA_NOT_ENABLED');
      await verifyProof(account, proof, ctx);
      const codes = await issueRecoveryCodes(account.id);
      await audit('auth.mfa.recovery_codes.regenerated', 'success', ctx, account.id, {
        count: codes.length,
      });
      return codes;
    },

    async getMfaStatus(accountId) {
      const account = await requireAccount(accountId);
      return {
        enabled: account.mfaEnabledAt !== null,
        recoveryCodesRemaining:
          account.mfaEnabledAt !== null ? await store.countUnusedRecoveryCodes(account.id) : 0,
      };
    },

    jwks() {
      return accessTokens
        ? (accessTokens.jwks() as { keys: Array<Record<string, unknown>> })
        : { keys: [] };
    },

    async purgeExpired() {
      return store.purgeExpired(clock.now());
    },

    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
  return auth;
}

function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
