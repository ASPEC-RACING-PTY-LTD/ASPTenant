import { type AuthVariables, createAuthRoutes } from '@aspec/auth/hono';
import { createHealth } from '@aspec/observability';
import { observability } from '@aspec/observability/hono';
import { createMemoryStore, createRateLimiter } from '@aspec/rate-limit';
import { Hono } from 'hono';
import { cookieSecure } from './config.js';
import { createPlatformIpResolver } from './http/client-ip.js';
import type { Platform } from './platform.js';
import { createAdminHttp } from './routes/admin-http.js';
import { createControlPlaneApi } from './routes/control-plane.js';
import { createMailHttp } from './routes/mail-http.js';
import { INTERNAL_HEADERS, resolveTenant, TENANT_HEADER, withTenant } from './tenancy.js';

const TRUSTED_ORIGIN = 'http://aspectenant.internal';

export function createApp(platform: Platform): Hono<{ Variables: AuthVariables }> {
  const resolveIp = createPlatformIpResolver(platform.config);
  const setupLimiter = createRateLimiter({
    store: createMemoryStore(),
    policy: { name: 'setup', limit: 10, windowMs: 60_000 },
    failureMode: 'closed',
  });

  const health = createHealth({
    logger: platform.logger,
    checks: {
      database: {
        check: () => platform.db.checkHealth(),
        critical: true,
      },
      mailApps: {
        // IMAPS 1993, SMTPS 1465, submission 1587. Reported, but does not block readiness.
        check: () => platform.mailServers.checkHealth(),
        critical: false,
      },
    },
  });

  const api = createControlPlaneApi(platform);
  const secure = cookieSecure(platform.config, platform.publicUrl);
  const auth = createAuthRoutes(platform.auth, {
    allowedOrigins: [TRUSTED_ORIGIN],
    cookie: {
      secure,
      name: secure ? '__Host-aspectenant_session' : 'aspectenant_session',
    },
    features: {
      register: false,
      login: true,
      logout: true,
      refresh: false,
      sessions: true,
      passwordReset: false,
      emailVerification: false,
      changePassword: true,
      changeEmail: false,
      mfa: false,
      oidc: false,
      webauthn: false,
      jwks: false,
    },
    getClientIp: (c) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
        ?.incoming?.socket?.remoteAddress;
      return resolveIp(incoming, (name) => c.req.header(name) ?? undefined);
    },
  });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(
    '*',
    observability({
      logger: platform.logger,
      endpoints: { health },
    }),
  );

  app.use('/api/v1/setup/*', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    const ip = resolveIp(incoming, (name) => c.req.header(name) ?? undefined) ?? 'unknown';
    if (!(await setupLimiter.consume(`setup:${ip}`)).allowed) {
      return c.json({ status: 429, detail: 'Too many setup attempts. Wait and try again.' }, 429);
    }
    return next();
  });

  app.use('/api/v1/setup', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    const ip = resolveIp(incoming, (name) => c.req.header(name) ?? undefined) ?? 'unknown';
    const decision = await setupLimiter.consume(`setup:${ip}`);
    if (!decision.allowed) {
      return c.json(
        {
          type: 'https://httpstatuses.com/429',
          title: 'Too Many Requests',
          status: 429,
          detail: 'Too many setup attempts. Wait and try again.',
        },
        429,
      );
    }
    return next();
  });

  app.route('/', auth.app);

  const forwardApi = async (c: {
    req: { raw: Request; path: string; header: (n: string) => string | undefined };
    env: unknown;
    get: (k: string) => unknown;
  }) => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    const ip = resolveIp(incoming, (name) => c.req.header(name) ?? undefined);
    const headers = new Headers(c.req.raw.headers);
    for (const name of INTERNAL_HEADERS) headers.delete(name);
    if (ip) headers.set('x-aspectenant-client-ip', ip);
    const authState = c.get('auth') as { account?: { id: string } } | null | undefined;
    const accountId = authState?.account?.id;
    if (accountId) headers.set('x-aspectenant-account-id', accountId);
    return api.handle(new Request(c.req.raw, { headers }), { path: c.req.path });
  };

  const publicApi = (path: string) =>
    path === '/api/v1/setup' ||
    path === '/api/v1/mail/ingest' ||
    path === '/api/v1/setup/restore' ||
    path === '/api/v1/platform' ||
    path === '/api/v1/openapi.json' ||
    path === '/api/v1/docs' ||
    path === '/api/openapi.json' ||
    path === '/api/docs';

  app.use('/api/*', async (c, next) => {
    if (publicApi(c.req.path) || c.req.method === 'OPTIONS') return next();
    return auth.requireAuth()(c, next);
  });
  // Bind every signed-in API request to one tenant the account is an active member of. Tenant
  // routes refuse to run without it; platform routes (tenant administration) do not need it.
  app.use('/api/*', async (c, next) => {
    const authState = c.get('auth') as { account?: { id: string } } | null | undefined;
    const accountId = authState?.account?.id;
    if (!accountId) return next();
    const tenant = await resolveTenant(platform, accountId, c.req.header(TENANT_HEADER));
    if (!tenant) return next();
    await withTenant(platform, tenant, accountId, () => next());
  });
  app.route(
    '/api/v1',
    createMailHttp(platform, (c) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
        ?.incoming?.socket?.remoteAddress;
      return resolveIp(incoming, (name) => c.req.header(name) ?? undefined);
    }),
  );
  app.route(
    '/api/v1',
    createAdminHttp(platform, (c) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
        ?.incoming?.socket?.remoteAddress;
      return resolveIp(incoming, (name) => c.req.header(name) ?? undefined);
    }),
  );
  app.get('/api/v1/session', auth.requireAuth(), async (c) => forwardApi(c));
  app.all('/api', (c) => forwardApi(c));
  app.all('/api/*', (c) => forwardApi(c));

  app.onError((err, c) => {
    platform.logger.error({ err }, err instanceof Error ? err.message : 'unhandled error');
    return c.json(
      {
        type: 'https://httpstatuses.com/500',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred.',
      },
      500,
    );
  });

  // CSRF: browser writes must come from this site (the Host the browser used, or the public
  // URL from Settings). Accepted requests continue with a fixed trusted origin, so the public
  // URL can change at runtime without reconfiguring the auth routes.
  const outer = new Hono<{ Variables: AuthVariables }>();
  outer.all('*', async (c) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return app.fetch(c.req.raw, c.env);
    const source = c.req.header('origin') ?? c.req.header('referer');
    if (!source) return app.fetch(c.req.raw, c.env);
    let host = '';
    try {
      host = new URL(source).host;
    } catch {
      host = '';
    }
    const own = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
    const allowed =
      host !== '' &&
      (host === own || (platform.publicUrl !== null && host === new URL(platform.publicUrl).host));
    if (!allowed) return c.json({ status: 403, detail: 'Cross-site request rejected.' }, 403);
    const headers = new Headers(c.req.raw.headers);
    headers.set('origin', TRUSTED_ORIGIN);
    headers.delete('referer');
    return app.fetch(new Request(c.req.raw, { headers }), c.env);
  });
  return outer;
}
