import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';
import type { Auth, LoginResult, RequestContext } from './auth.js';
import { randomToken, sha256Hex } from './crypto.js';
import { normalizeEmail } from './email.js';
import { AuthError, configError } from './errors.js';
import type { Clock } from './ports.js';

export type OidcProviderKind = 'oidc' | 'oauth2';

export interface OidcProfile {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  raw: Record<string, unknown>;
}

export interface OidcProviderConfig {
  /** Stable provider id used in URLs and identity records (for example `google`). */
  id: string;
  kind?: OidcProviderKind;
  clientId: string;
  clientSecret: string;
  /** OIDC issuer URL. Required for `oidc` providers (discovery). */
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  scopes?: readonly string[];
  /** Extra authorization query parameters. */
  authorizationParams?: Record<string, string>;
  /**
   * Map a token-response / userinfo payload to a normalised profile. Required for `oauth2`
   * providers; optional for `oidc` (defaults to standard claims).
   */
  mapProfile?: (input: {
    idTokenPayload?: JWTPayload;
    userinfo?: Record<string, unknown>;
    tokenResponse: Record<string, unknown>;
  }) => OidcProfile;
}

export interface OidcOptions {
  providers: readonly OidcProviderConfig[];
  /** Absolute redirect URI registered with every provider (for example `${AUTH_APP_URL}/auth/oidc/google/callback`). */
  redirectUri: string | ((providerId: string) => string);
  /** Allow creating accounts on first successful sign-in. Default true. */
  allowSignup?: boolean;
  /**
   * Auto-link a verified provider email to an existing local account that already owns that
   * email. Off by default; only enable when you trust the provider's email_verified claim.
   */
  autoLinkByEmail?: boolean;
  /** Transaction (state/nonce) lifetime. Default 600000 (10 minutes). */
  transactionTtlMs?: number;
  /** Cached discovery document TTL. Default 3600000 (1 hour). */
  discoveryCacheTtlMs?: number;
  /** Injected fetch for tests. */
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
}

export interface OidcService {
  hasProvider(providerId: string): boolean;
  listProviders(): string[];
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
  unlink(
    accountId: string,
    provider: string,
    subject: string,
    context?: RequestContext,
  ): Promise<boolean>;
  listIdentities(
    accountId: string,
  ): Promise<Array<{ provider: string; subject: string; email: string | null; createdAt: number }>>;
}

interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  fetchedAt: number;
}

interface TransactionData {
  provider: string;
  codeVerifier: string;
  nonce: string;
  redirectTo?: string;
  linkAccountId?: string;
}

const PRESETS: Record<string, Omit<OidcProviderConfig, 'id' | 'clientId' | 'clientSecret'>> = {
  google: {
    kind: 'oidc',
    issuer: 'https://accounts.google.com',
    scopes: ['openid', 'email', 'profile'],
  },
  microsoft: {
    kind: 'oidc',
    issuer: 'https://login.microsoftonline.com/common/v2.0',
    scopes: ['openid', 'email', 'profile'],
  },
  github: {
    kind: 'oauth2',
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userinfoEndpoint: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
    mapProfile: ({ userinfo, tokenResponse }) => {
      const info = userinfo ?? {};
      const id = info.id;
      if (id === undefined || id === null)
        throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', { message: 'GitHub profile missing id' });
      const email = typeof info.email === 'string' ? info.email : undefined;
      return {
        subject: String(id),
        ...(email ? { email, emailVerified: Boolean(info.email) } : {}),
        ...(typeof info.name === 'string' ? { name: info.name } : {}),
        raw: { ...info, token_type: tokenResponse.token_type },
      };
    },
  },
};

/** Built-in provider presets (Google, Microsoft Entra ID, GitHub). Credentials still required. */
export function oidcPreset(
  name: 'google' | 'microsoft' | 'github',
  credentials: { clientId: string; clientSecret: string; id?: string; issuer?: string },
): OidcProviderConfig {
  const base = PRESETS[name];
  if (!base) configError('providers', `unknown preset ${name}`);
  const id = credentials.id ?? name;
  const out: OidcProviderConfig = {
    ...base,
    id,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
  if (credentials.issuer) out.issuer = credentials.issuer;
  return out;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'utf8').digest());
}

function defaultOidcProfile(payload: JWTPayload, userinfo?: Record<string, unknown>): OidcProfile {
  const sub =
    typeof payload.sub === 'string'
      ? payload.sub
      : typeof userinfo?.sub === 'string'
        ? userinfo.sub
        : undefined;
  if (!sub) throw new AuthError('AUTH_OIDC_ID_TOKEN_INVALID', { message: 'Missing subject' });
  const email =
    typeof payload.email === 'string'
      ? payload.email
      : typeof userinfo?.email === 'string'
        ? userinfo.email
        : undefined;
  const emailVerified =
    typeof payload.email_verified === 'boolean'
      ? payload.email_verified
      : typeof userinfo?.email_verified === 'boolean'
        ? userinfo.email_verified
        : undefined;
  const name =
    typeof payload.name === 'string'
      ? payload.name
      : typeof userinfo?.name === 'string'
        ? userinfo.name
        : undefined;
  return {
    subject: sub,
    ...(email ? { email } : {}),
    ...(emailVerified !== undefined ? { emailVerified } : {}),
    ...(name ? { name } : {}),
    raw: { ...(userinfo ?? {}), ...payload } as Record<string, unknown>,
  };
}

/**
 * Creates the OAuth 2.0 / OpenID Connect integration used by HTTP adapters via `options.oidc`.
 * Providers are tested against in-process mocks; Google / Microsoft / GitHub presets are
 * configuration helpers only.
 */
export function createOidc(auth: Auth, options: OidcOptions): OidcService {
  if (!options.providers?.length) configError('providers', 'must list at least one provider');
  const allowSignup = options.allowSignup ?? true;
  const autoLinkByEmail = options.autoLinkByEmail ?? false;
  const transactionTtlMs = options.transactionTtlMs ?? 600_000;
  const discoveryCacheTtlMs = options.discoveryCacheTtlMs ?? 3_600_000;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? auth.internals.clock;
  const store = auth.internals.store;
  const providers = new Map<string, OidcProviderConfig>();
  for (const p of options.providers) {
    if (!p.id || !/^[a-z][a-z0-9_-]{0,63}$/.test(p.id))
      configError('providers[].id', 'must be a lowercase identifier');
    if (providers.has(p.id)) configError('providers', `duplicate provider id ${p.id}`);
    const kind = p.kind ?? (p.issuer ? 'oidc' : 'oauth2');
    if (kind === 'oidc' && !p.issuer && !(p.authorizationEndpoint && p.tokenEndpoint)) {
      configError(`providers.${p.id}`, 'oidc providers need issuer or explicit endpoints');
    }
    if (kind === 'oauth2' && !(p.authorizationEndpoint && p.tokenEndpoint)) {
      configError(
        `providers.${p.id}`,
        'oauth2 providers need authorizationEndpoint and tokenEndpoint',
      );
    }
    if (!p.clientId || !p.clientSecret)
      configError(`providers.${p.id}`, 'clientId and clientSecret are required');
    providers.set(p.id, { ...p, kind });
  }

  const discoveryCache = new Map<string, DiscoveredEndpoints>();
  const jwksCache = new Map<
    string,
    { fetchedAt: number; set: ReturnType<typeof createLocalJWKSet> }
  >();

  const redirectUriFor = (providerId: string): string => {
    const uri =
      typeof options.redirectUri === 'function'
        ? options.redirectUri(providerId)
        : options.redirectUri;
    try {
      const u = new URL(uri);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad protocol');
      return uri;
    } catch {
      configError('redirectUri', 'must be an absolute http(s) URL');
    }
  };

  const resolveEndpoints = async (provider: OidcProviderConfig): Promise<DiscoveredEndpoints> => {
    if (provider.authorizationEndpoint && provider.tokenEndpoint) {
      return {
        authorizationEndpoint: provider.authorizationEndpoint,
        tokenEndpoint: provider.tokenEndpoint,
        ...(provider.userinfoEndpoint ? { userinfoEndpoint: provider.userinfoEndpoint } : {}),
        ...(provider.jwksUri ? { jwksUri: provider.jwksUri } : {}),
        fetchedAt: clock.now(),
      };
    }
    const issuer = provider.issuer?.replace(/\/+$/, '');
    if (!issuer) configError(`providers.${provider.id}`, 'issuer is required for discovery');
    const cached = discoveryCache.get(issuer);
    if (cached && clock.now() - cached.fetchedAt < discoveryCacheTtlMs) return cached;
    const res = await fetchFn(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok)
      throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', {
        message: `Discovery failed (${res.status})`,
      });
    const doc = (await res.json()) as Record<string, unknown>;
    const authorizationEndpoint = doc.authorization_endpoint;
    const tokenEndpoint = doc.token_endpoint;
    if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', { message: 'Discovery document incomplete' });
    }
    const endpoints: DiscoveredEndpoints = {
      authorizationEndpoint,
      tokenEndpoint,
      ...(typeof doc.userinfo_endpoint === 'string'
        ? { userinfoEndpoint: doc.userinfo_endpoint }
        : {}),
      ...(typeof doc.jwks_uri === 'string' ? { jwksUri: doc.jwks_uri } : {}),
      fetchedAt: clock.now(),
    };
    discoveryCache.set(issuer, endpoints);
    return endpoints;
  };

  const getProvider = (id: string): OidcProviderConfig => {
    const p = providers.get(id);
    if (!p) throw new AuthError('AUTH_OIDC_PROVIDER_UNKNOWN');
    return p;
  };

  const exchangeCode = async (
    provider: OidcProviderConfig,
    endpoints: DiscoveredEndpoints,
    code: string,
    codeVerifier: string,
  ): Promise<Record<string, unknown>> => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUriFor(provider.id),
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: codeVerifier,
    });
    const res = await fetchFn(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== 'string') {
      throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', {
        message:
          typeof json.error === 'string' ? json.error : `Token exchange failed (${res.status})`,
      });
    }
    return json;
  };

  const fetchUserinfo = async (
    endpoints: DiscoveredEndpoints,
    accessToken: string,
  ): Promise<Record<string, unknown> | undefined> => {
    if (!endpoints.userinfoEndpoint) return undefined;
    const res = await fetchFn(endpoints.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  };

  const getJwks = async (jwksUri: string): Promise<ReturnType<typeof createLocalJWKSet>> => {
    const cached = jwksCache.get(jwksUri);
    if (cached && clock.now() - cached.fetchedAt < discoveryCacheTtlMs) return cached.set;
    const res = await fetchFn(jwksUri, { headers: { Accept: 'application/json' } });
    if (!res.ok)
      throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', {
        message: `JWKS fetch failed (${res.status})`,
      });
    const body = (await res.json()) as JSONWebKeySet;
    const set = createLocalJWKSet(body);
    jwksCache.set(jwksUri, { fetchedAt: clock.now(), set });
    return set;
  };

  const verifyIdToken = async (
    provider: OidcProviderConfig,
    endpoints: DiscoveredEndpoints,
    idToken: string,
    nonce: string,
  ): Promise<JWTPayload> => {
    const jwksUri = endpoints.jwksUri ?? provider.jwksUri;
    if (!jwksUri) throw new AuthError('AUTH_OIDC_ID_TOKEN_INVALID', { message: 'No JWKS URI' });
    const jwks = await getJwks(jwksUri);
    try {
      const issuer = provider.issuer?.replace(/\/+$/, '');
      const { payload } = await jwtVerify(idToken, jwks, {
        ...(issuer ? { issuer } : {}),
        audience: provider.clientId,
        clockTolerance: 5,
        currentDate: new Date(clock.now()),
      });
      if (payload.nonce !== nonce)
        throw new AuthError('AUTH_OIDC_ID_TOKEN_INVALID', { message: 'nonce mismatch' });
      if (typeof payload.azp === 'string' && payload.azp !== provider.clientId) {
        throw new AuthError('AUTH_OIDC_ID_TOKEN_INVALID', { message: 'azp mismatch' });
      }
      return payload;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('AUTH_OIDC_ID_TOKEN_INVALID', { cause: err });
    }
  };

  const resolveProfile = async (
    provider: OidcProviderConfig,
    endpoints: DiscoveredEndpoints,
    tokenResponse: Record<string, unknown>,
    nonce: string,
  ): Promise<OidcProfile> => {
    const accessToken = tokenResponse.access_token as string;
    let idTokenPayload: JWTPayload | undefined;
    if (typeof tokenResponse.id_token === 'string' && (provider.kind ?? 'oidc') === 'oidc') {
      idTokenPayload = await verifyIdToken(provider, endpoints, tokenResponse.id_token, nonce);
    }
    const userinfo = await fetchUserinfo(endpoints, accessToken);
    if (provider.mapProfile) {
      return provider.mapProfile({
        ...(idTokenPayload ? { idTokenPayload } : {}),
        ...(userinfo ? { userinfo } : {}),
        tokenResponse,
      });
    }
    if (!idTokenPayload && !userinfo) {
      throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', { message: 'No ID token or userinfo' });
    }
    return defaultOidcProfile(idTokenPayload ?? {}, userinfo);
  };

  return {
    hasProvider(providerId) {
      return providers.has(providerId);
    },
    listProviders() {
      return [...providers.keys()];
    },

    async createAuthorizationUrl({ provider: providerId, redirectTo, linkAccountId }) {
      const provider = getProvider(providerId);
      const endpoints = await resolveEndpoints(provider);
      const codeVerifier = b64url(randomBytes(32));
      const nonce = b64url(randomBytes(32));
      const state = randomToken(32);
      const now = clock.now();
      const expiresAt = now + transactionTtlMs;
      const data: TransactionData = {
        provider: providerId,
        codeVerifier,
        nonce,
        ...(redirectTo ? { redirectTo } : {}),
        ...(linkAccountId ? { linkAccountId } : {}),
      };
      await store.createOneTimeToken({
        id: auth.internals.generateId(),
        tokenHash: sha256Hex(state),
        purpose: 'oidc-transaction',
        accountId: linkAccountId ?? null,
        data: data as unknown as Record<string, unknown>,
        attempts: 0,
        createdAt: now,
        expiresAt,
        usedAt: null,
      });
      const url = new URL(endpoints.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', provider.clientId);
      url.searchParams.set('redirect_uri', redirectUriFor(providerId));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
      const scopes =
        provider.scopes ??
        ((provider.kind ?? 'oidc') === 'oidc' ? ['openid', 'email', 'profile'] : ['read:user']);
      url.searchParams.set('scope', scopes.join(' '));
      if ((provider.kind ?? 'oidc') === 'oidc') url.searchParams.set('nonce', nonce);
      for (const [k, v] of Object.entries(provider.authorizationParams ?? {}))
        url.searchParams.set(k, v);
      return { url: url.toString(), state, expiresAt };
    },

    async handleCallback({
      provider: providerId,
      params,
      expectedState,
      context,
      currentSessionToken,
    }) {
      const provider = getProvider(providerId);
      if (params.error) {
        throw new AuthError('AUTH_OIDC_PROVIDER_ERROR', {
          message:
            typeof params.error_description === 'string' ? params.error_description : params.error,
        });
      }
      const state = params.state;
      const code = params.code;
      if (!state || !code) throw new AuthError('AUTH_OIDC_STATE_MISMATCH');
      if (expectedState !== undefined && expectedState !== state)
        throw new AuthError('AUTH_OIDC_STATE_MISMATCH');
      const tx = await store.consumeOneTimeToken(sha256Hex(state), 'oidc-transaction', clock.now());
      const data = tx?.data as unknown as TransactionData | undefined;
      if (
        !data ||
        data.provider !== providerId ||
        typeof data.codeVerifier !== 'string' ||
        typeof data.nonce !== 'string'
      ) {
        throw new AuthError('AUTH_OIDC_STATE_MISMATCH');
      }
      const endpoints = await resolveEndpoints(provider);
      const tokenResponse = await exchangeCode(provider, endpoints, code, data.codeVerifier);
      const profile = await resolveProfile(provider, endpoints, tokenResponse, data.nonce);
      const email = profile.email ? normalizeEmail(profile.email) : undefined;

      if (data.linkAccountId) {
        const existing = await store.getIdentity(providerId, profile.subject);
        if (existing && existing.accountId !== data.linkAccountId) {
          throw new AuthError('AUTH_IDENTITY_ALREADY_LINKED');
        }
        if (!existing) {
          const created = await store.createIdentity({
            id: auth.internals.generateId(),
            accountId: data.linkAccountId,
            provider: providerId,
            subject: profile.subject,
            email: email ?? null,
            createdAt: clock.now(),
            lastLoginAt: null,
          });
          if (!created) throw new AuthError('AUTH_IDENTITY_ALREADY_LINKED');
        }
        await auth.internals.recordAudit({
          action: 'auth.oidc.linked',
          outcome: 'success',
          category: 'security',
          ...auth.internals.context(context, data.linkAccountId),
          resource: { type: 'auth.account', id: data.linkAccountId },
          metadata: { provider: providerId },
        });
        return {
          result: { status: 'linked' },
          ...(data.redirectTo ? { redirectTo: data.redirectTo } : {}),
        };
      }

      let identity = await store.getIdentity(providerId, profile.subject);
      let accountId = identity?.accountId;

      if (!accountId && autoLinkByEmail && email && profile.emailVerified) {
        const byEmail = await store.getAccountByEmail(email);
        if (byEmail) {
          const linked = await store.createIdentity({
            id: auth.internals.generateId(),
            accountId: byEmail.id,
            provider: providerId,
            subject: profile.subject,
            email,
            createdAt: clock.now(),
            lastLoginAt: null,
          });
          if (linked) {
            accountId = byEmail.id;
            identity = await store.getIdentity(providerId, profile.subject);
          }
        }
      }

      if (!accountId) {
        if (!allowSignup) throw new AuthError('AUTH_OIDC_SIGNUP_DISABLED');
        if (!email) throw new AuthError('AUTH_OIDC_EMAIL_REQUIRED');
        const existingEmail = await store.getAccountByEmail(email);
        if (existingEmail) throw new AuthError('AUTH_OIDC_ACCOUNT_CONFLICT');
        const account = await auth.createAccount({
          email,
          emailVerified: profile.emailVerified === true,
          ...(context ? { context } : {}),
        });
        accountId = account.id;
        await store.createIdentity({
          id: auth.internals.generateId(),
          accountId,
          provider: providerId,
          subject: profile.subject,
          email,
          createdAt: clock.now(),
          lastLoginAt: null,
        });
      } else if (identity) {
        await store.touchIdentity(identity.id, clock.now(), email ?? null);
      }

      const result = await auth.signIn(accountId, {
        method: 'oidc',
        ...(context ? { context } : {}),
        ...(currentSessionToken ? { currentSessionToken } : {}),
      });
      return { result, ...(data.redirectTo ? { redirectTo: data.redirectTo } : {}) };
    },

    async unlink(accountId, provider, subject, context) {
      const ok = await store.deleteIdentity(accountId, provider, subject);
      if (ok) {
        await auth.internals.recordAudit({
          action: 'auth.oidc.unlinked',
          outcome: 'success',
          category: 'security',
          ...auth.internals.context(context, accountId),
          resource: { type: 'auth.account', id: accountId },
          metadata: { provider, subject },
        });
      }
      return ok;
    },

    async listIdentities(accountId) {
      const rows = await store.listIdentities(accountId);
      return rows.map((r) => ({
        provider: r.provider,
        subject: r.subject,
        email: r.email,
        createdAt: r.createdAt,
      }));
    },
  };
}
