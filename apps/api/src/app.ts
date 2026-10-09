import { type AuthVariables, createAuthRoutes } from '@aspec/auth/hono';
import { createHealth } from '@aspec/observability';
import { observability } from '@aspec/observability/hono';
import { createMemoryStore, createRateLimiter } from '@aspec/rate-limit';
import { Hono } from 'hono';
import { cookieSecure, publicOrigin } from './config.js';
import { createPlatformIpResolver } from './http/client-ip.js';
import type { Platform } from './platform.js';
import { createControlPlaneApi } from './routes/control-plane.js';
import { INTERNAL_HEADERS, resolveTenant, TENANT_HEADER, withTenant } from './tenancy.js';

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
    },
  });

  const api = createControlPlaneApi(platform);
  const auth = createAuthRoutes(platform.auth, {
    allowedOrigins: [publicOrigin(platform.config)],
    cookie: {
      secure: cookieSecure(platform.config),
      name: cookieSecure(platform.config) ? '__Host-aspectenant_session' : 'aspectenant_session',
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
    const forward = () => api.handle(new Request(c.req.raw, { headers }), { path: c.req.path });
    if (!accountId) return forward();

    // Bind the request to one tenant the account is an active member of. Tenant routes refuse
    // to run without it; platform routes do not need it.
    const tenant = await resolveTenant(platform, accountId, c.req.header(TENANT_HEADER));
    if (!tenant) return forward();
    return withTenant(platform, tenant, accountId, forward);
  };

  const publicApi = (path: string) =>
    path === '/api/v1/setup' ||
    path === '/api/v1/platform' ||
    path === '/api/v1/openapi.json' ||
    path === '/api/v1/docs' ||
    path === '/api/openapi.json' ||
    path === '/api/docs';

  app.use('/api/*', async (c, next) => {
    if (publicApi(c.req.path) || c.req.method === 'OPTIONS') return next();
    return auth.requireAuth()(c, next);
  });
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

  return app;
}
