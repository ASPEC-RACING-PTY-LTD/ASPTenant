/** Error codes thrown by @aspec/auth. Every code is stable and documented in troubleshooting.md. */
export const AUTH_ERROR_CODES = {
  AUTH_CONFIG_INVALID: {
    status: 500,
    expose: false,
    message: 'Invalid authentication configuration',
  },
  AUTH_VALIDATION_FAILED: { status: 400, expose: true, message: 'The request is invalid' },
  AUTH_INVALID_CREDENTIALS: { status: 401, expose: true, message: 'Invalid email or password' },
  AUTH_ACCOUNT_LOCKED: {
    status: 423,
    expose: true,
    message: 'The account is temporarily locked',
  },
  AUTH_ACCOUNT_DISABLED: { status: 403, expose: true, message: 'The account is disabled' },
  AUTH_ACCOUNT_NOT_FOUND: { status: 404, expose: true, message: 'Account not found' },
  AUTH_EMAIL_TAKEN: { status: 409, expose: true, message: 'The email address is already in use' },
  AUTH_EMAIL_NOT_VERIFIED: {
    status: 403,
    expose: true,
    message: 'The email address has not been verified',
  },
  AUTH_PASSWORD_POLICY: {
    status: 400,
    expose: true,
    message: 'The password does not meet the password policy',
  },
  AUTH_PASSWORD_COMPROMISED: {
    status: 400,
    expose: true,
    message: 'The password has appeared in a data breach; choose a different password',
  },
  AUTH_PASSWORD_NOT_SET: {
    status: 400,
    expose: true,
    message: 'The account has no password; use password reset to set one',
  },
  AUTH_RATE_LIMITED: { status: 429, expose: true, message: 'Too many attempts; try again later' },
  AUTH_UNAUTHENTICATED: { status: 401, expose: true, message: 'Authentication required' },
  AUTH_SESSION_EXPIRED: { status: 401, expose: true, message: 'The session has expired' },
  AUTH_SESSION_NOT_FOUND: { status: 404, expose: true, message: 'Session not found' },
  AUTH_INVALID_TOKEN: { status: 401, expose: true, message: 'The token is invalid or expired' },
  AUTH_REFRESH_TOKEN_REUSED: {
    status: 401,
    expose: true,
    message: 'The refresh token is invalid or expired',
  },
  AUTH_MFA_REQUIRED: { status: 401, expose: true, message: 'Multifactor authentication required' },
  AUTH_MFA_INVALID_CODE: { status: 401, expose: true, message: 'The verification code is invalid' },
  AUTH_MFA_ALREADY_ENABLED: {
    status: 409,
    expose: true,
    message: 'Multifactor authentication is already enabled',
  },
  AUTH_MFA_NOT_ENABLED: {
    status: 409,
    expose: true,
    message: 'Multifactor authentication is not enabled',
  },
  AUTH_MFA_NOT_CONFIGURED: {
    status: 501,
    expose: true,
    message: 'Multifactor authentication is not configured',
  },
  AUTH_CSRF_REJECTED: { status: 403, expose: true, message: 'Request origin is not allowed' },
  AUTH_PAYLOAD_TOO_LARGE: { status: 413, expose: true, message: 'The request body is too large' },
  AUTH_UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    expose: true,
    message: 'Request bodies must be application/json',
  },
  AUTH_NOT_FOUND: { status: 404, expose: true, message: 'Not found' },
  AUTH_METHOD_NOT_ALLOWED: { status: 405, expose: true, message: 'Method not allowed' },
  AUTH_FEATURE_DISABLED: { status: 404, expose: true, message: 'This feature is not enabled' },
  AUTH_DELIVERY_UNAVAILABLE: {
    status: 500,
    expose: false,
    message: 'No mailer or delivery handler is configured',
  },
  AUTH_OIDC_PROVIDER_UNKNOWN: { status: 404, expose: true, message: 'Unknown identity provider' },
  AUTH_OIDC_STATE_MISMATCH: {
    status: 400,
    expose: true,
    message: 'The sign-in request is invalid or expired',
  },
  AUTH_OIDC_PROVIDER_ERROR: {
    status: 502,
    expose: true,
    message: 'The identity provider returned an error',
  },
  AUTH_OIDC_ID_TOKEN_INVALID: {
    status: 401,
    expose: true,
    message: 'The identity provider token is invalid',
  },
  AUTH_OIDC_EMAIL_REQUIRED: {
    status: 400,
    expose: true,
    message: 'The identity provider did not return an email address',
  },
  AUTH_OIDC_ACCOUNT_CONFLICT: {
    status: 409,
    expose: true,
    message: 'An account with this email already exists; sign in and link the provider instead',
  },
  AUTH_OIDC_SIGNUP_DISABLED: {
    status: 403,
    expose: true,
    message: 'No account is linked to this identity',
  },
  AUTH_IDENTITY_ALREADY_LINKED: {
    status: 409,
    expose: true,
    message: 'This identity is already linked to another account',
  },
  AUTH_WEBAUTHN_CHALLENGE_INVALID: {
    status: 400,
    expose: true,
    message: 'The passkey challenge is invalid or expired',
  },
  AUTH_WEBAUTHN_VERIFICATION_FAILED: {
    status: 401,
    expose: true,
    message: 'Passkey verification failed',
  },
  AUTH_WEBAUTHN_CREDENTIAL_NOT_FOUND: {
    status: 404,
    expose: true,
    message: 'Passkey not found',
  },
  AUTH_STORE_FULL: { status: 503, expose: false, message: 'Authentication store capacity reached' },
  AUTH_INTERNAL: { status: 500, expose: false, message: 'Internal authentication error' },
} as const satisfies Record<string, { status: number; expose: boolean; message: string }>;

export type AuthErrorCode = keyof typeof AUTH_ERROR_CODES;

export interface AuthErrorOptions {
  message?: string;
  details?: unknown;
  cause?: unknown;
  /** Seconds until a retry makes sense (rate limiting and lockout). */
  retryAfterSeconds?: number;
}

/**
 * Error thrown by every @aspec/auth API. Satisfies the ErrorLike port (`code`, `status`,
 * `expose`, `details`) so @aspec/errors or any problem+json mapper can translate it.
 */
export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly code: AuthErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(code: AuthErrorCode, options: AuthErrorOptions = {}) {
    const def = AUTH_ERROR_CODES[code];
    super(
      options.message ?? def.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.status = def.status;
    this.expose = def.expose;
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}

/** Throws AUTH_CONFIG_INVALID naming the offending option. */
export function configError(option: string, problem: string): never {
  throw new AuthError('AUTH_CONFIG_INVALID', { message: `Invalid option ${option}: ${problem}` });
}
