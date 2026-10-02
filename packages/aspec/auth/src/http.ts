import type {
  AccessTokenAuth,
  Auth,
  AuthenticatedResult,
  LoginResult,
  PublicAccount,
  RequestContext,
  SessionInfo,
} from './auth.js';
import {
  type CookieOptions,
  clearSessionCookie,
  parseCookies,
  type ResolvedCookieOptions,
  resolveCookieOptions,
  serializeCookie,
  sessionCookie,
} from './cookies.js';
import { normalizeEmail } from './email.js';
import { AuthError, configError } from './errors.js';
import type { LoggerLike } from './ports.js';
import type { AccessTokenClaims } from './tokens.js';

/** Framework-neutral request passed from an adapter to the HTTP handler. */
export interface AuthHttpRequest {
  method: string;
  /** Path and query, for example `/auth/login?x=1`. */
  url: string;
  /** Returns a header value (case-insensitive name) or undefined. */
  header(name: string): string | undefined;
  /** Raw body read by the adapter within `maxBodyBytes`. */
  body?: string;
  /** Body already parsed by upstream middleware (for example express.json()). */
  parsedBody?: unknown;
  /** Client IP as determined by the framework (respecting its proxy configuration). */
  ip?: string;
}

export interface AuthHttpResponse {
  status: number;
  /** Header pairs; `set-cookie` may appear several times. */
  headers: Array<[string, string]>;
  body?: string;
}

/** Authentication attached to a request by requireAuth. */
export interface RequestAuth {
  account: PublicAccount;
  session: SessionInfo;
  /** How the request authenticated. */
  method: 'cookie' | 'bearer';
  /** Access token claims for bearer requests. */
  claims?: AccessTokenClaims;
}

/** Structural view of the OIDC service from `@aspec/auth/oidc` used by the HTTP layer. */
export interface OidcHttpIntegration {
  hasProvider(providerId: string): boolean;
  createAuthorizationUrl(input: {
    provider: string;
    redirectTo?: string;
    linkAccountId?: string;
  }): Promise<{ url: string; state: string; expiresAt: number }>;
  handleCallback(input: {
    provider: string;
    params: Record<string, string>;
    expectedState?: string;
    context?: RequestContext;
    currentSessionToken?: string;
  }): Promise<{ result: LoginResult | { status: 'linked' }; redirectTo?: string }>;
}

/** Structural view of the WebAuthn service from `@aspec/auth/webauthn` used by the HTTP layer. */
export interface WebAuthnHttpIntegration {
  generateRegistrationOptions(accountId: string): Promise<unknown>;
  verifyRegistration(
    accountId: string,
    response: unknown,
    input?: { name?: string; context?: RequestContext },
  ): Promise<unknown>;
  generateAuthenticationOptions(input?: { accountId?: string }): Promise<unknown>;
  verifyAuthentication(
    response: unknown,
    input?: { context?: RequestContext; currentSessionToken?: string; issueTokens?: boolean },
  ): Promise<LoginResult>;
  listCredentials(accountId: string): Promise<unknown[]>;
  removeCredential(
    accountId: string,
    credentialId: string,
    context?: RequestContext,
  ): Promise<boolean>;
}

/** Delivery hooks used when no mailer is configured on the Auth instance. */
export interface TokenDelivery {
  passwordReset?(input: { email: string; token: string }): Promise<void>;
  emailVerification?(input: { email: string; token: string; accountId: string }): Promise<void>;
}

export interface AuthHttpFeatures {
  register?: boolean;
  login?: boolean;
  logout?: boolean;
  refresh?: boolean;
  sessions?: boolean;
  passwordReset?: boolean;
  emailVerification?: boolean;
  changePassword?: boolean;
  changeEmail?: boolean;
  mfa?: boolean;
  oidc?: boolean;
  webauthn?: boolean;
  jwks?: boolean;
}

export interface AuthHttpOptions {
  /** Mount path of the endpoints. Default `/auth`. */
  basePath?: string;
  /** Origins (scheme://host[:port]) allowed to send state-changing cookie requests. Required unless csrf is false. */
  allowedOrigins?: readonly string[];
  /** Origin checks for state-changing requests. Default true. */
  csrf?: boolean;
  cookie?: CookieOptions;
  /** Session transports clients may request with `mode`. First entry is the default. Default ['cookie']. */
  modes?: ReadonlyArray<'cookie' | 'token'>;
  /** Maximum request body size in bytes. Default 16384. */
  maxBodyBytes?: number;
  features?: AuthHttpFeatures;
  registration?: {
    /** Respond identically for new and existing emails and do not sign in on registration. Default true. */
    preventEnumeration?: boolean;
  };
  oidc?: OidcHttpIntegration;
  webauthn?: WebAuthnHttpIntegration;
  delivery?: TokenDelivery;
  /** Redirect targets used by the OIDC callback (relative paths or allowed-origin URLs). */
  oidcRedirects?: { success?: string; error?: string; mfa?: string };
  logger?: LoggerLike;
}

export interface AuthHttpHandler {
  readonly basePath: string;
  readonly maxBodyBytes: number;
  readonly cookie: ResolvedCookieOptions;
  /** True when the path is under basePath. Adapters use it to decide whether to read the body. */
  matches(path: string): boolean;
  /** Handles a request under basePath. Returns undefined when the path is outside basePath. */
  handle(req: AuthHttpRequest): Promise<AuthHttpResponse | undefined>;
  /** Authenticates by bearer token or session cookie. Returns null when unauthenticated and optional. */
  authenticate(
    req: AuthHttpRequest,
    options?: { csrf?: boolean; optional?: boolean },
  ): Promise<RequestAuth | null>;
  /** Converts any error to a problem+json response without leaking internals. */
  errorResponse(err: unknown): AuthHttpResponse;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Parses the AUTH_ALLOWED_ORIGINS format (comma-separated origins). */
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

type Body = Record<string, unknown>;

function field(
  body: Body,
  name: string,
  options: { max?: number; optional?: boolean } = {},
): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === '') {
    if (options.optional) return undefined;
    throw new AuthError('AUTH_VALIDATION_FAILED', {
      message: `${name} is required`,
      details: [{ field: name, message: 'is required' }],
    });
  }
  if (typeof value !== 'string' || value.length > (options.max ?? 1024)) {
    throw new AuthError('AUTH_VALIDATION_FAILED', {
      message: `${name} must be a string of at most ${options.max ?? 1024} characters`,
      details: [{ field: name, message: 'must be a string' }],
    });
  }
  return value;
}

const required = (body: Body, name: string, max?: number) =>
  field(body, name, max === undefined ? {} : { max }) as string;

function json(
  status: number,
  body: unknown,
  headers: Array<[string, string]> = [],
): AuthHttpResponse {
  return {
    status,
    headers: [
      ['content-type', 'application/json; charset=utf-8'],
      ['cache-control', 'no-store'],
      ...headers,
    ],
    body: JSON.stringify(body),
  };
}

function noContent(headers: Array<[string, string]> = []): AuthHttpResponse {
  return { status: 204, headers: [['cache-control', 'no-store'], ...headers] };
}

function redirect(location: string, headers: Array<[string, string]> = []): AuthHttpResponse {
  return {
    status: 302,
    headers: [['location', location], ['cache-control', 'no-store'], ...headers],
  };
}

interface RouteContext {
  req: AuthHttpRequest;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Body;
  ctx: RequestContext;
  cookies: Record<string, string>;
  sessionToken: string | undefined;
}

type RouteHandler = (rc: RouteContext) => Promise<AuthHttpResponse>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/**
 * Creates the framework-neutral HTTP layer used by the Express, Fastify, Hono and Fetch adapters.
 * Custom adapters can call it directly.
 */
export function createAuthHttpHandler(auth: Auth, options: AuthHttpOptions = {}): AuthHttpHandler {
  const basePath = (options.basePath ?? '/auth').replace(/\/+$/, '');
  if (basePath !== '' && !/^\/[A-Za-z0-9._~\-/]*$/.test(basePath))
    configError('basePath', 'must be a path such as /auth');
  const csrf = options.csrf ?? true;
  const allowedOrigins = new Set<string>();
  for (const [i, o] of (options.allowedOrigins ?? []).entries()) {
    const normalized = normalizeOrigin(o);
    if (!normalized) configError(`allowedOrigins[${i}]`, 'must be an http or https origin');
    allowedOrigins.add(normalized);
  }
  if (csrf && allowedOrigins.size === 0) {
    configError(
      'allowedOrigins',
      'must list at least one origin (or set csrf: false for non-browser APIs)',
    );
  }
  const cookie = resolveCookieOptions(options.cookie);
  const oidcCookie = {
    name: cookie.name.startsWith('__Host-') ? '__Host-aspec_oidc' : 'aspec_oidc',
    secure: cookie.secure,
  };
  const modes = options.modes ?? ['cookie'];
  if (modes.length === 0 || modes.some((m) => m !== 'cookie' && m !== 'token')) {
    configError('modes', 'must contain cookie and/or token');
  }
  if (modes.includes('token') && !auth.config.tokensEnabled)
    configError('modes', 'token mode requires the tokens option on createAuth');
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1_048_576) {
    configError('maxBodyBytes', 'must be between 1024 and 1048576');
  }
  const preventEnumeration = options.registration?.preventEnumeration ?? true;
  const delivery = options.delivery;
  const logger = options.logger ?? auth.internals.logger;
  const canDeliverReset = auth.config.hasMailer || typeof delivery?.passwordReset === 'function';
  const canDeliverVerification =
    auth.config.hasMailer || typeof delivery?.emailVerification === 'function';
  const f = options.features ?? {};
  const features: Required<AuthHttpFeatures> = {
    register: f.register ?? true,
    login: f.login ?? true,
    logout: f.logout ?? true,
    refresh: f.refresh ?? auth.config.tokensEnabled,
    sessions: f.sessions ?? true,
    passwordReset: f.passwordReset ?? canDeliverReset,
    emailVerification: f.emailVerification ?? true,
    changePassword: f.changePassword ?? true,
    changeEmail: f.changeEmail ?? canDeliverVerification,
    mfa: f.mfa ?? auth.config.mfaEnabled,
    oidc: f.oidc ?? options.oidc !== undefined,
    webauthn: f.webauthn ?? options.webauthn !== undefined,
    jwks: f.jwks ?? auth.config.tokensEnabled,
  };
  if (features.passwordReset && !canDeliverReset)
    configError('features.passwordReset', 'needs a mailer on createAuth or delivery.passwordReset');
  if (features.changeEmail && !canDeliverVerification) {
    configError(
      'features.changeEmail',
      'needs a mailer on createAuth or delivery.emailVerification',
    );
  }
  if (features.refresh && !auth.config.tokensEnabled)
    configError('features.refresh', 'requires the tokens option on createAuth');
  if (features.mfa && !auth.config.mfaEnabled)
    configError('features.mfa', 'requires the mfa option on createAuth');
  if (features.oidc && !options.oidc) configError('features.oidc', 'requires the oidc option');
  if (features.webauthn && !options.webauthn)
    configError('features.webauthn', 'requires the webauthn option');
  const redirects = {
    success: options.oidcRedirects?.success ?? '/',
    error: options.oidcRedirects?.error ?? '/login',
    mfa: options.oidcRedirects?.mfa ?? '/login/mfa',
  };

  const routes: Route[] = [];
  const add = (enabled: boolean, method: string, path: string, handler: RouteHandler) => {
    if (enabled) routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  };

  const background = (label: string, fn: () => Promise<void> | undefined) => {
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          `auth ${label} delivery failed`,
        ),
      );
  };

  const originAllowed = (req: AuthHttpRequest, hasSessionCookie: boolean) => {
    const origin = req.header('origin');
    let source: string | undefined;
    if (origin !== undefined) {
      if (origin === 'null') return false;
      source = normalizeOrigin(origin);
      if (!source) return false;
    } else {
      const referer = req.header('referer');
      if (referer !== undefined) {
        source = normalizeOrigin(referer);
        if (!source) return false;
      }
    }
    // Browsers send Origin on every cross-site state-changing request. A request with neither
    // header is a non-browser client; it is accepted only when it carries no session cookie.
    if (source === undefined) return !hasSessionCookie;
    return allowedOrigins.has(source);
  };

  const enforceCsrf = (req: AuthHttpRequest, cookies: Record<string, string>) => {
    if (!csrf || SAFE_METHODS.has(req.method)) return;
    const hasCookie = cookies[cookie.name] !== undefined;
    const bearer = /^Bearer\s+/i.test(req.header('authorization') ?? '');
    if (bearer && !hasCookie) return;
    if (!originAllowed(req, hasCookie)) throw new AuthError('AUTH_CSRF_REJECTED');
  };

  const parseBody = (req: AuthHttpRequest): Body => {
    if (req.parsedBody !== undefined && req.body === undefined) {
      const pb = req.parsedBody;
      if (pb === null || typeof pb !== 'object' || Array.isArray(pb)) {
        throw new AuthError('AUTH_VALIDATION_FAILED', {
          message: 'The request body must be a JSON object',
        });
      }
      return pb as Body;
    }
    const raw = req.body ?? '';
    if (raw.trim().length === 0) return {};
    if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes)
      throw new AuthError('AUTH_PAYLOAD_TOO_LARGE');
    const type = (req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json' && !type?.endsWith('+json'))
      throw new AuthError('AUTH_UNSUPPORTED_MEDIA_TYPE');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AuthError('AUTH_VALIDATION_FAILED', {
        message: 'The request body is not valid JSON',
      });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AuthError('AUTH_VALIDATION_FAILED', {
        message: 'The request body must be a JSON object',
      });
    }
    return parsed as Body;
  };

  const contextOf = (req: AuthHttpRequest): RequestContext => {
    const ctx: RequestContext = {};
    if (req.ip) ctx.ip = req.ip;
    const ua = req.header('user-agent');
    if (ua) ctx.userAgent = ua.slice(0, 512);
    const rid = req.header('x-request-id');
    if (rid && /^[A-Za-z0-9._:-]{1,128}$/.test(rid)) ctx.requestId = rid;
    return ctx;
  };

  const bearerToken = (req: AuthHttpRequest): string | undefined => {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(req.header('authorization') ?? '');
    return m?.[1];
  };

  const authenticate = async (
    req: AuthHttpRequest,
    opts: { csrf?: boolean; optional?: boolean } = {},
  ): Promise<RequestAuth | null> => {
    const cookies = parseCookies(req.header('cookie'));
    const ctx = contextOf(req);
    const bearer = bearerToken(req);
    try {
      if (bearer) {
        const r: AccessTokenAuth = await auth.authenticateAccessToken(bearer, ctx);
        return { account: r.account, session: r.session, method: 'bearer', claims: r.claims };
      }
      const token = cookies[cookie.name];
      if (token) {
        if (opts.csrf ?? true) enforceCsrf(req, cookies);
        const r = await auth.authenticateSession(token, ctx);
        return { account: r.account, session: r.session, method: 'cookie' };
      }
    } catch (err) {
      if (opts.optional && err instanceof AuthError && err.status === 401) return null;
      throw err;
    }
    if (opts.optional) return null;
    throw new AuthError('AUTH_UNAUTHENTICATED');
  };

  const mustAuth = async (rc: RouteContext) =>
    (await authenticate(rc.req, { csrf: false })) as RequestAuth;

  const chooseMode = (body: Body): 'cookie' | 'token' => {
    const requested = body.mode;
    if (requested === undefined) return modes[0] as 'cookie' | 'token';
    if (requested !== 'cookie' && requested !== 'token') {
      throw new AuthError('AUTH_VALIDATION_FAILED', {
        message: 'mode must be cookie or token',
        details: [{ field: 'mode' }],
      });
    }
    if (!modes.includes(requested)) {
      throw new AuthError('AUTH_VALIDATION_FAILED', {
        message: `mode ${requested} is not enabled`,
        details: [{ field: 'mode' }],
      });
    }
    return requested;
  };

  const cookieFor = (
    result: AuthenticatedResult | { sessionToken: string; session: SessionInfo },
  ) =>
    sessionCookie(
      cookie,
      result.sessionToken,
      Math.max(0, Math.floor((result.session.expiresAt - auth.internals.clock.now()) / 1000)),
    );

  const renderLogin = (result: LoginResult, mode: 'cookie' | 'token'): AuthHttpResponse => {
    if (result.status === 'mfa_required') {
      return json(200, {
        status: 'mfa_required',
        challengeToken: result.challengeToken,
        expiresAt: result.expiresAt,
        methods: result.methods,
      });
    }
    const body: Record<string, unknown> = {
      status: 'authenticated',
      account: result.account,
      session: result.session,
    };
    if (mode === 'token') {
      body.tokens = result.tokens;
      return json(200, body);
    }
    return json(200, body, [['set-cookie', cookieFor(result)]]);
  };

  const proofFrom = (body: Body) => {
    const password = field(body, 'password', { optional: true, max: 4096 });
    if (password !== undefined) return { password };
    const code = field(body, 'code', { optional: true, max: 16 });
    if (code !== undefined) return { totp: code };
    throw new AuthError('AUTH_VALIDATION_FAILED', {
      message: 'password or code is required',
      details: [{ field: 'password' }, { field: 'code' }],
    });
  };

  const safeRedirect = (target: string | undefined, fallback: string): string => {
    if (!target) return fallback;
    if (target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\'))
      return target;
    const origin = normalizeOrigin(target);
    return origin && allowedOrigins.has(origin) ? target : fallback;
  };

  // ---------- routes ----------

  add(features.register, 'POST', '/register', async (rc) => {
    const body = rc.body();
    const email = required(body, 'email', 320);
    const password = required(body, 'password', 4096);
    const mode = chooseMode(body);
    let created: Awaited<ReturnType<Auth['register']>> | undefined;
    try {
      created = await auth.register({ email, password, context: rc.ctx });
    } catch (err) {
      if (!(preventEnumeration && err instanceof AuthError && err.code === 'AUTH_EMAIL_TAKEN'))
        throw err;
    }
    if (created?.verificationToken && delivery?.emailVerification) {
      const { account, verificationToken } = created;
      background('email verification', () =>
        delivery.emailVerification?.({
          email: account.email,
          token: verificationToken,
          accountId: account.id,
        }),
      );
    }
    if (preventEnumeration || !created) return json(202, { status: 'accepted' });
    const result = await auth.signIn(created.account.id, {
      method: 'password',
      context: rc.ctx,
      issueTokens: mode === 'token',
      ...(rc.sessionToken ? { currentSessionToken: rc.sessionToken } : {}),
    });
    const res = renderLogin(result, mode);
    res.status = 201;
    return res;
  });

  add(features.login, 'POST', '/login', async (rc) => {
    const body = rc.body();
    const email = required(body, 'email', 320);
    const password = required(body, 'password', 4096);
    const mode = chooseMode(body);
    const result = await auth.login({
      email,
      password,
      context: rc.ctx,
      issueTokens: mode === 'token',
      ...(rc.sessionToken ? { currentSessionToken: rc.sessionToken } : {}),
    });
    return renderLogin(result, mode);
  });

  add(features.login, 'POST', '/mfa/challenge', async (rc) => {
    const body = rc.body();
    const challengeToken = required(body, 'challengeToken', 512);
    const code = field(body, 'code', { optional: true, max: 16 });
    const recoveryCode = field(body, 'recoveryCode', { optional: true, max: 64 });
    const mode = chooseMode(body);
    const result = await auth.completeMfaChallenge({
      challengeToken,
      ...(code !== undefined ? { code } : {}),
      ...(recoveryCode !== undefined ? { recoveryCode } : {}),
      context: rc.ctx,
      issueTokens: mode === 'token',
      ...(rc.sessionToken ? { currentSessionToken: rc.sessionToken } : {}),
    });
    return renderLogin(result, mode);
  });

  add(features.logout, 'POST', '/logout', async (rc) => {
    const a = await authenticate(rc.req, { csrf: false, optional: true });
    if (a?.method === 'bearer') await auth.revokeSession(a.account.id, a.session.id, rc.ctx);
    if (rc.sessionToken) await auth.logout(rc.sessionToken, rc.ctx);
    return noContent([['set-cookie', clearSessionCookie(cookie)]]);
  });

  add(features.refresh, 'POST', '/refresh', async (rc) => {
    const body = rc.body();
    const refreshToken = required(body, 'refreshToken', 512);
    const { account, session, tokens } = await auth.refresh(refreshToken, rc.ctx);
    return json(200, { status: 'authenticated', account, session, tokens });
  });

  add(features.sessions, 'GET', '/session', async (rc) => {
    const a = await mustAuth(rc);
    return json(200, { account: a.account, session: a.session, method: a.method });
  });

  add(features.sessions, 'GET', '/sessions', async (rc) => {
    const a = await mustAuth(rc);
    return json(200, { sessions: await auth.listSessions(a.account.id, a.session.id) });
  });

  add(features.sessions, 'DELETE', '/sessions/:id', async (rc) => {
    const a = await mustAuth(rc);
    const id = rc.params.id as string;
    if (!(await auth.revokeSession(a.account.id, id, rc.ctx)))
      throw new AuthError('AUTH_SESSION_NOT_FOUND');
    const headers: Array<[string, string]> =
      id === a.session.id && a.method === 'cookie'
        ? [['set-cookie', clearSessionCookie(cookie)]]
        : [];
    return noContent(headers);
  });

  add(features.sessions, 'DELETE', '/sessions', async (rc) => {
    const a = await mustAuth(rc);
    const revoked = await auth.revokeAllSessions(a.account.id, {
      exceptSessionId: a.session.id,
      context: rc.ctx,
    });
    return json(200, { revoked });
  });

  add(features.changePassword, 'POST', '/password/change', async (rc) => {
    const a = await mustAuth(rc);
    const body = rc.body();
    const out = await auth.changePassword({
      accountId: a.account.id,
      currentPassword: required(body, 'currentPassword', 4096),
      newPassword: required(body, 'newPassword', 4096),
      context: rc.ctx,
      ...(a.method === 'cookie' && rc.sessionToken
        ? { currentSessionToken: rc.sessionToken }
        : { currentSessionId: a.session.id }),
    });
    const headers: Array<[string, string]> = [];
    if (out.sessionToken && out.session)
      headers.push([
        'set-cookie',
        cookieFor({ sessionToken: out.sessionToken, session: out.session }),
      ]);
    return json(200, { status: 'password_changed' }, headers);
  });

  add(features.passwordReset, 'POST', '/password/reset/request', async (rc) => {
    const body = rc.body();
    const email = required(body, 'email', 320);
    const { token } = await auth.requestPasswordReset({ email, context: rc.ctx });
    if (token && delivery?.passwordReset) {
      const account = await auth.getAccountByEmail(email);
      if (account)
        background('password reset', () =>
          delivery.passwordReset?.({ email: account.email, token }),
        );
    }
    return json(202, { status: 'accepted' });
  });

  add(features.passwordReset, 'POST', '/password/reset/confirm', async (rc) => {
    const body = rc.body();
    await auth.resetPassword({
      token: required(body, 'token', 512),
      newPassword: required(body, 'newPassword', 4096),
      context: rc.ctx,
    });
    return json(200, { status: 'password_reset' }, [['set-cookie', clearSessionCookie(cookie)]]);
  });

  add(features.emailVerification, 'POST', '/email/verify', async (rc) => {
    const body = rc.body();
    const { email } = await auth.verifyEmail({
      token: required(body, 'token', 512),
      context: rc.ctx,
    });
    return json(200, { status: 'verified', email });
  });

  add(
    features.emailVerification && canDeliverVerification,
    'POST',
    '/email/verify/resend',
    async (rc) => {
      const a = await mustAuth(rc);
      const out = await auth.sendEmailVerification(a.account.id, rc.ctx);
      if (out.token && delivery?.emailVerification) {
        const token = out.token;
        background('email verification', () =>
          delivery.emailVerification?.({ email: a.account.email, token, accountId: a.account.id }),
        );
      }
      return json(202, { status: out.alreadyVerified ? 'already_verified' : 'accepted' });
    },
  );

  add(features.changeEmail, 'POST', '/email/change', async (rc) => {
    const a = await mustAuth(rc);
    const body = rc.body();
    const newEmail = required(body, 'newEmail', 320);
    const currentPassword = field(body, 'currentPassword', { optional: true, max: 4096 });
    const out = await auth.changeEmail({
      accountId: a.account.id,
      newEmail,
      context: rc.ctx,
      ...(currentPassword !== undefined ? { currentPassword } : {}),
    });
    if (out.token && delivery?.emailVerification) {
      const token = out.token;
      const target = normalizeEmail(newEmail) ?? newEmail;
      background('email change', () =>
        delivery.emailVerification?.({ email: target, token, accountId: a.account.id }),
      );
    }
    return json(202, { status: 'accepted' });
  });

  add(features.mfa, 'GET', '/mfa', async (rc) => {
    const a = await mustAuth(rc);
    return json(200, await auth.getMfaStatus(a.account.id));
  });

  add(features.mfa, 'POST', '/mfa/totp/enroll', async (rc) => {
    const a = await mustAuth(rc);
    return json(200, await auth.beginTotpEnrollment(a.account.id));
  });

  add(features.mfa, 'POST', '/mfa/totp/confirm', async (rc) => {
    const a = await mustAuth(rc);
    const body = rc.body();
    const out = await auth.confirmTotpEnrollment(a.account.id, required(body, 'code', 16), {
      context: rc.ctx,
      ...(a.method === 'cookie' && rc.sessionToken ? { currentSessionToken: rc.sessionToken } : {}),
    });
    const headers: Array<[string, string]> = [];
    if (out.sessionToken && out.session)
      headers.push([
        'set-cookie',
        cookieFor({ sessionToken: out.sessionToken, session: out.session }),
      ]);
    return json(200, { status: 'mfa_enabled', recoveryCodes: out.recoveryCodes }, headers);
  });

  add(features.mfa, 'POST', '/mfa/totp/disable', async (rc) => {
    const a = await mustAuth(rc);
    await auth.disableTotp(a.account.id, proofFrom(rc.body()), rc.ctx);
    return noContent();
  });

  add(features.mfa, 'POST', '/mfa/recovery-codes', async (rc) => {
    const a = await mustAuth(rc);
    const codes = await auth.regenerateRecoveryCodes(a.account.id, proofFrom(rc.body()), rc.ctx);
    return json(200, { recoveryCodes: codes });
  });

  add(features.jwks, 'GET', '/jwks', async () =>
    json(200, auth.jwks(), [['cache-control', 'public, max-age=300']]),
  );

  const oidc = options.oidc;
  add(features.oidc, 'GET', '/oidc/:provider/start', async (rc) => {
    const provider = rc.params.provider as string;
    if (!oidc?.hasProvider(provider)) throw new AuthError('AUTH_OIDC_PROVIDER_UNKNOWN');
    let linkAccountId: string | undefined;
    if (rc.query.get('link') === '1') linkAccountId = (await mustAuth(rc)).account.id;
    const redirectTo = rc.query.get('redirectTo') ?? undefined;
    const { url, state, expiresAt } = await oidc.createAuthorizationUrl({
      provider,
      ...(redirectTo ? { redirectTo: safeRedirect(redirectTo, redirects.success) } : {}),
      ...(linkAccountId ? { linkAccountId } : {}),
    });
    const stateCookie = serializeCookie(oidcCookie.name, state, {
      httpOnly: true,
      secure: oidcCookie.secure,
      sameSite: 'lax',
      path: '/',
      maxAgeSeconds: Math.floor((expiresAt - auth.internals.clock.now()) / 1000),
    });
    return redirect(url, [['set-cookie', stateCookie]]);
  });

  add(features.oidc, 'GET', '/oidc/:provider/callback', async (rc) => {
    const provider = rc.params.provider as string;
    const clearState = serializeCookie(oidcCookie.name, '', {
      httpOnly: true,
      secure: oidcCookie.secure,
      sameSite: 'lax',
      path: '/',
      maxAgeSeconds: 0,
    });
    const params: Record<string, string> = {};
    for (const [k, v] of rc.query) if (v.length <= 4096 && !(k in params)) params[k] = v;
    try {
      if (!oidc?.hasProvider(provider)) throw new AuthError('AUTH_OIDC_PROVIDER_UNKNOWN');
      const expectedState = rc.cookies[oidcCookie.name];
      if (!expectedState) throw new AuthError('AUTH_OIDC_STATE_MISMATCH');
      const { result, redirectTo } = await oidc.handleCallback({
        provider,
        params,
        expectedState,
        context: rc.ctx,
        ...(rc.sessionToken ? { currentSessionToken: rc.sessionToken } : {}),
      });
      if (result.status === 'mfa_required') {
        const target = `${safeRedirect(redirects.mfa, '/')}#challengeToken=${encodeURIComponent(result.challengeToken)}`;
        return redirect(target, [['set-cookie', clearState]]);
      }
      const headers: Array<[string, string]> = [['set-cookie', clearState]];
      if (result.status === 'authenticated') headers.push(['set-cookie', cookieFor(result)]);
      return redirect(safeRedirect(redirectTo, redirects.success), headers);
    } catch (err) {
      const code = err instanceof AuthError ? err.code : 'AUTH_INTERNAL';
      if (!(err instanceof AuthError) || err.status >= 500) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), provider },
          'auth oidc callback failed',
        );
      }
      const target = safeRedirect(redirects.error, '/');
      const sep = target.includes('?') ? '&' : '?';
      return redirect(`${target}${sep}error=${encodeURIComponent(code)}`, [
        ['set-cookie', clearState],
      ]);
    }
  });

  const webauthn = options.webauthn;
  add(features.webauthn, 'POST', '/webauthn/register/options', async (rc) => {
    const a = await mustAuth(rc);
    return json(200, await webauthn?.generateRegistrationOptions(a.account.id));
  });

  add(features.webauthn, 'POST', '/webauthn/register/verify', async (rc) => {
    const a = await mustAuth(rc);
    const body = rc.body();
    const name = field(body, 'name', { optional: true, max: 100 });
    if (body.response === null || typeof body.response !== 'object') {
      throw new AuthError('AUTH_VALIDATION_FAILED', {
        message: 'response is required',
        details: [{ field: 'response' }],
      });
    }
    const credential = await webauthn?.verifyRegistration(a.account.id, body.response, {
      context: rc.ctx,
      ...(name !== undefined ? { name } : {}),
    });
    return json(201, { credential });
  });

  add(features.webauthn, 'POST', '/webauthn/login/options', async () =>
    json(200, await webauthn?.generateAuthenticationOptions()),
  );

  add(features.webauthn, 'POST', '/webauthn/login/verify', async (rc) => {
    const body = rc.body();
    if (body.response === null || typeof body.response !== 'object') {
      throw new AuthError('AUTH_VALIDATION_FAILED', {
        message: 'response is required',
        details: [{ field: 'response' }],
      });
    }
    const mode = chooseMode(body);
    const result = (await webauthn?.verifyAuthentication(body.response, {
      context: rc.ctx,
      issueTokens: mode === 'token',
      ...(rc.sessionToken ? { currentSessionToken: rc.sessionToken } : {}),
    })) as LoginResult;
    return renderLogin(result, mode);
  });

  add(features.webauthn, 'GET', '/webauthn/credentials', async (rc) => {
    const a = await mustAuth(rc);
    return json(200, { credentials: await webauthn?.listCredentials(a.account.id) });
  });

  add(features.webauthn, 'DELETE', '/webauthn/credentials/:id', async (rc) => {
    const a = await mustAuth(rc);
    if (!(await webauthn?.removeCredential(a.account.id, rc.params.id as string, rc.ctx))) {
      throw new AuthError('AUTH_WEBAUTHN_CREDENTIAL_NOT_FOUND');
    }
    return noContent();
  });

  // ---------- dispatch ----------

  const errorResponse = (err: unknown): AuthHttpResponse => {
    if (err instanceof AuthError) {
      if (err.status >= 500)
        logger.error({ code: err.code, err: err.message }, 'auth request failed');
      const problem: Record<string, unknown> = {
        type: 'about:blank',
        title: STATUS_TITLES[err.status] ?? 'Error',
        status: err.status,
        code: err.code,
      };
      if (err.expose) {
        problem.detail = err.message;
        if (err.details !== undefined) problem.details = err.details;
      }
      const headers: Array<[string, string]> = [
        ['content-type', 'application/problem+json; charset=utf-8'],
        ['cache-control', 'no-store'],
      ];
      if (err.retryAfterSeconds !== undefined)
        headers.push(['retry-after', String(err.retryAfterSeconds)]);
      return { status: err.status, headers, body: JSON.stringify(problem) };
    }
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
      'auth request failed',
    );
    return {
      status: 500,
      headers: [
        ['content-type', 'application/problem+json; charset=utf-8'],
        ['cache-control', 'no-store'],
      ],
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'AUTH_INTERNAL',
      }),
    };
  };

  const matches = (path: string) =>
    path === basePath || path.startsWith(`${basePath}/`) || basePath === '';

  const handle = async (req: AuthHttpRequest): Promise<AuthHttpResponse | undefined> => {
    let url: URL;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return undefined;
    }
    if (!matches(url.pathname)) return undefined;
    const rel = url.pathname.slice(basePath.length);
    const segments = rel.split('/').filter(Boolean);
    const method = req.method.toUpperCase();
    let matchedPath = false;
    for (const route of routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segments.length; i++) {
        const expected = route.segments[i] as string;
        const actual = segments[i] as string;
        if (expected.startsWith(':')) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(actual);
          } catch {
            ok = false;
            break;
          }
          if (decoded.length > 512) {
            ok = false;
            break;
          }
          params[expected.slice(1)] = decoded;
        } else if (expected !== actual) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      matchedPath = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      try {
        const cookies = parseCookies(req.header('cookie'));
        enforceCsrf(req, cookies);
        let parsed: Body | undefined;
        const rc: RouteContext = {
          req,
          params,
          query: url.searchParams,
          body: () => {
            parsed ??= parseBody(req);
            return parsed;
          },
          ctx: contextOf(req),
          cookies,
          sessionToken: cookies[cookie.name],
        };
        return await route.handler(rc);
      } catch (err) {
        return errorResponse(err);
      }
    }
    return errorResponse(new AuthError(matchedPath ? 'AUTH_METHOD_NOT_ALLOWED' : 'AUTH_NOT_FOUND'));
  };

  return { basePath, maxBodyBytes, cookie, matches, handle, authenticate, errorResponse };
}

/**
 * Reads a body stream up to `limit` bytes. Throws AUTH_PAYLOAD_TOO_LARGE beyond the limit so
 * oversized bodies are never buffered completely.
 */
export async function readLimitedBody(
  source: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array> | null | undefined,
  limit: number,
  declaredLength?: string | null,
): Promise<string> {
  if (declaredLength) {
    const n = Number(declaredLength);
    if (Number.isFinite(n) && n > limit) throw new AuthError('AUTH_PAYLOAD_TOO_LARGE');
  }
  if (!source) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (chunk: Uint8Array | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buf.byteLength;
    if (size > limit) throw new AuthError('AUTH_PAYLOAD_TOO_LARGE');
    chunks.push(buf);
  };
  if ('getReader' in source) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of source) push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
