import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionAuth } from '@aspec/auth';
import Provider, {
  type Account,
  type Configuration,
  type InteractionResults,
  type KoaContextWithOIDC,
} from 'oidc-provider';
import type { Platform } from '../platform.js';
import { createAdapterFactory, purgeExpired } from './adapter.js';
import { type ClientRecord, OidcClients } from './clients.js';

/** Path the provider is mounted at; the issuer is the public URL plus this path. */
export const OIDC_PATH = '/oidc';
const INTERACTION_PATH = `${OIDC_PATH}/interaction/`;
const SESSION_COOKIES = ['__Host-aspectenant_session', 'aspectenant_session'];

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#0f141c;color:#e6e9ef;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px;background:#171e29;border:1px solid #2a3442;border-radius:10px;padding:24px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#b7c0cc}button{background:#5b7cfa;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:15px;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new Error('Body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * The OpenID Connect provider. It signs people in to registered applications with their
 * ASPECTenant account: authorization code with PKCE, client secrets for server applications,
 * rotatable RS256 signing keys and fresh sign-in on `prompt=login` or `max_age`.
 */
export class IdentityProvider {
  readonly clients: OidcClients;
  private readonly platform: Platform;
  private provider: Provider | null = null;
  private issuer: string | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(platform: Platform) {
    this.platform = platform;
    this.clients = new OidcClients(platform);
  }

  /** Issuer URL, or null while no public URL is set. */
  get issuerUrl(): string | null {
    return this.platform.publicUrl
      ? `${this.platform.publicUrl.replace(/\/+$/, '')}${OIDC_PATH}`
      : null;
  }

  private instance(): Provider | null {
    const issuer = this.issuerUrl;
    if (!issuer) return null;
    if (this.provider && this.issuer === issuer) return this.provider;
    this.provider = this.build(issuer);
    this.issuer = issuer;
    if (!this.purgeTimer) {
      this.purgeTimer = setInterval(
        () => {
          void purgeExpired(this.platform.db).catch(() => undefined);
        },
        60 * 60 * 1000,
      );
      this.purgeTimer.unref();
    }
    return this.provider;
  }

  /** Publishes a new signing key and signs with it from now on. */
  async rotateSigningKey(): Promise<void> {
    const keys = await this.platform.identity.store.rotateSigningKey();
    this.platform.identity.keys = keys;
    this.provider = null;
  }

  stop(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  private build(issuer: string): Provider {
    const platform = this.platform;
    const clients = this.clients;
    const keys = platform.identity.keys;

    const recordFor = async (ctx: KoaContextWithOIDC): Promise<ClientRecord | null> => {
      const clientId = ctx.oidc.client?.clientId;
      return clientId ? clients.findByClientId(clientId) : null;
    };

    const configuration: Configuration = {
      adapter: createAdapterFactory(platform.db, clients),
      clients: [],
      jwks: { keys: keys.signing as unknown as NonNullable<Configuration['jwks']>['keys'] },
      cookies: { keys: keys.cookieKeys },
      claims: {
        openid: ['sub', 'tid'],
        email: ['email', 'email_verified'],
        profile: ['name'],
      },
      // Put email and name in the ID token, not only behind the userinfo endpoint.
      conformIdTokenClaims: false,
      scopes: ['openid', 'email', 'profile', 'offline_access'],
      responseTypes: ['code'],
      clientAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
      pkce: { required: () => true },
      enabledJWA: {
        idTokenSigningAlgValues: ['RS256'],
        userinfoSigningAlgValues: ['RS256'],
        requestObjectSigningAlgValues: ['RS256'],
        clientAuthSigningAlgValues: ['RS256'],
      },
      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        userinfo: { enabled: true },
        rpInitiatedLogout: { enabled: true },
      },
      ttl: {
        AccessToken: 60 * 60,
        AuthorizationCode: 60,
        IdToken: 60 * 60,
        Interaction: 30 * 60,
        Session: 14 * 24 * 60 * 60,
        Grant: 14 * 24 * 60 * 60,
        RefreshToken: 30 * 24 * 60 * 60,
      },
      interactions: {
        url: (_ctx, interaction) => `${INTERACTION_PATH}${interaction.uid}`,
      },
      // First-party applications need no consent screen, but every application\'s access rules
      // apply before a grant is issued, including when a provider session already exists.
      loadExistingGrant: async (ctx) => {
        const accountId = ctx.oidc.session?.accountId;
        const clientId = ctx.oidc.client?.clientId;
        if (!accountId || !clientId) return undefined;
        const record = await clients.findByClientId(clientId);
        if (!record) return undefined;
        const mfa = (ctx.oidc.session?.amr ?? []).includes('mfa');
        if (await clients.refusal(record, accountId, mfa)) return undefined;
        const existingId =
          ctx.oidc.result?.consent?.grantId || ctx.oidc.session?.grantIdFor(clientId);
        const grant =
          (existingId ? await ctx.oidc.provider.Grant.find(existingId) : undefined) ??
          new ctx.oidc.provider.Grant({ clientId, accountId });
        grant.addOIDCScope([...ctx.oidc.requestParamScopes].join(' '));
        await grant.save();
        return grant;
      },
      findAccount: async (ctx, sub): Promise<Account | undefined> => {
        const account = await platform.auth.getAccount(sub);
        const user = await platform.users.findUser(sub);
        if (!account || !user || user.status !== 'active' || account.disabled) return undefined;
        const record = await recordFor(ctx);
        // Tokens stop working once the person leaves the tenant or loses access.
        if (record && (await clients.refusal(record, sub, true))) return undefined;
        return {
          accountId: sub,
          claims: async () => ({
            sub,
            email: account.email,
            email_verified: account.emailVerified,
            name: user.profile.displayName ?? account.email,
            ...(record ? { tid: record.tenantId } : {}),
          }),
        };
      },
      renderError: async (ctx, out) => {
        ctx.type = 'html';
        ctx.body = page(
          'Sign-in problem',
          `<h1>Sign-in problem</h1><p>${escapeHtml(out.error_description ?? out.error)}</p>`,
        );
      },
    };

    const provider = new Provider(issuer, configuration);
    provider.proxy = true;
    // Client secrets are stored hashed: compare against the hash, never a plain value.
    provider.Client.prototype.compareClientSecret = async function compare(
      this: { clientSecret?: string },
      actual: string,
    ) {
      return this.clientSecret ? clients.verifySecret(this.clientSecret, actual) : false;
    };
    provider.on('server_error', (_ctx, error) => {
      platform.logger.error({ err: error }, 'oidc provider error');
    });
    return provider;
  }

  /** Handles a request under /oidc. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const provider = this.instance();
    if (!provider) {
      sendJson(res, 503, {
        error: 'temporarily_unavailable',
        error_description:
          'Sign-in with ASPECTenant needs the public URL. Set it under Settings first.',
      });
      return;
    }
    const issuer = new URL(this.issuer ?? '');
    // The issuer decides the scheme and host; the reverse proxy in front may speak plain HTTP.
    req.headers['x-forwarded-proto'] = issuer.protocol.replace(':', '');
    req.headers['x-forwarded-host'] = issuer.host;
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    try {
      if (path.startsWith(INTERACTION_PATH)) {
        await this.interaction(provider, req, res, path.slice(INTERACTION_PATH.length));
        return;
      }
      const original = req.url ?? '/';
      req.url = original.slice(OIDC_PATH.length) || '/';
      (req as IncomingMessage & { originalUrl?: string }).originalUrl = original;
      await provider.callback()(req, res);
    } catch (error) {
      this.platform.logger.error({ err: error }, 'oidc request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    }
  }

  private async sessionFor(req: IncomingMessage): Promise<SessionAuth | null> {
    for (const name of SESSION_COOKIES) {
      const token = readCookie(req.headers.cookie, name);
      if (!token) continue;
      try {
        return await this.platform.auth.authenticateSession(token);
      } catch {
        // An expired or revoked session counts as not signed in.
      }
    }
    return null;
  }

  /** Same-origin check for the interaction API, which the sign-in page calls. */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return Boolean(origin && this.issuer && new URL(this.issuer).origin === origin);
  }

  private async interaction(
    provider: Provider,
    req: IncomingMessage,
    res: ServerResponse,
    rest: string,
  ): Promise<void> {
    const [uid = '', action = ''] = rest.split('/');
    if (req.method === 'GET' && !action) {
      // The sign-in page lives in the web app.
      res.writeHead(302, { location: `/sign-in/${encodeURIComponent(uid)}` });
      res.end();
      return;
    }
    let details: Awaited<ReturnType<Provider['interactionDetails']>>;
    try {
      details = await provider.interactionDetails(req, res);
    } catch {
      sendJson(res, 410, {
        error: 'This sign-in request has expired. Go back to the application and start again.',
      });
      return;
    }
    if (details.uid !== uid) {
      sendJson(res, 400, { error: 'Sign-in request mismatch.' });
      return;
    }
    const clientId = String(details.params.client_id ?? '');
    const record = await this.clients.findByClientId(clientId);
    if (!record) {
      sendJson(res, 404, { error: 'This application is not registered.' });
      return;
    }
    const session = await this.sessionFor(req);
    const reasons = details.prompt.reasons ?? [];
    const startedAt = (details.iat ?? 0) * 1000;
    const maxAge = details.params.max_age === undefined ? null : Number(details.params.max_age);
    // prompt=login needs a sign-in after this request began; max_age needs one within it.
    let freshAfter: number | null = null;
    if (details.prompt.name === 'login') {
      if (reasons.includes('login_prompt')) freshAfter = startedAt;
      if (reasons.includes('max_age') && maxAge !== null) {
        freshAfter = Math.max(freshAfter ?? 0, Date.now() - maxAge * 1000);
      }
    }
    const signedIn =
      session && (freshAfter === null || session.session.createdAt >= freshAfter) ? session : null;
    const refusal = signedIn
      ? await this.clients.refusal(record, signedIn.account.id, signedIn.session.mfaVerified)
      : null;

    if (req.method === 'GET' && action === 'details') {
      sendJson(res, 200, {
        application: record.name,
        signedInAs: signedIn ? signedIn.account.email : null,
        // A session exists but is too old for this request.
        reauthenticate: Boolean(session && !signedIn),
        email: session?.account.email ?? null,
        refusal,
      });
      return;
    }
    if (req.method !== 'POST' || !this.sameOrigin(req)) {
      sendJson(res, 403, { error: 'Not allowed.' });
      return;
    }
    await readJson(req).catch(() => ({}));
    let result: InteractionResults;
    if (action === 'abort') {
      result = { error: 'access_denied', error_description: 'The person cancelled sign-in.' };
    } else if (action === 'continue') {
      if (!signedIn) {
        sendJson(res, 409, { error: 'Sign in to continue.', reauthenticate: Boolean(session) });
        return;
      }
      if (refusal) {
        sendJson(res, 403, { error: refusal });
        return;
      }
      result = {
        login: {
          accountId: signedIn.account.id,
          ts: Math.floor(signedIn.session.createdAt / 1000),
          amr: signedIn.session.mfaVerified ? ['pwd', 'mfa'] : ['pwd'],
          remember: true,
        },
      };
      // Applications are first party: grant the requested scopes without a consent screen.
      // Native (public) clients need this in every interaction, as they cannot authenticate.
      const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
      const grant =
        existing?.accountId === signedIn.account.id
          ? existing
          : new provider.Grant({ clientId, accountId: signedIn.account.id });
      grant.addOIDCScope(String(details.params.scope ?? 'openid'));
      result = { ...result, consent: { grantId: await grant.save() } };
      await this.platform.audit.record({
        action: 'auth.oidc.sign_in',
        outcome: 'success',
        category: 'security',
        actor: { id: signedIn.account.id, type: 'user' },
        resource: { type: 'application', id: record.id },
        tenantId: record.tenantId,
        changes: { after: { client: record.clientId, mfa: signedIn.session.mfaVerified } },
      });
    } else {
      sendJson(res, 404, { error: 'Unknown action.' });
      return;
    }
    const redirectTo = await provider.interactionResult(req, res, result, {
      mergeWithLastSubmission: false,
    });
    sendJson(res, 200, { redirectTo });
  }
}
