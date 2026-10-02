import { createHash, generateKeyPairSync } from 'node:crypto';
import { exportJWK, type JWK, SignJWT } from 'jose';

export interface MockOidcUser {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * In-process mock OIDC provider with discovery, authorize, token and JWKS endpoints.
 * Served through a custom `fetch` that routes matching URLs here.
 */
export function createMockOidcProvider(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  user: MockOidcUser;
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let publicJwk: JWK | undefined;
  const codes = new Map<string, { codeChallenge: string; nonce: string; redirectUri: string }>();
  let failNextToken = false;
  let badNonce = false;

  const base = options.issuer.replace(/\/+$/, '');

  const ensureJwk = async () => {
    if (!publicJwk) {
      publicJwk = await exportJWK(publicKey);
      publicJwk.alg = 'ES256';
      publicJwk.use = 'sig';
      publicJwk.kid = 'mock-1';
    }
    return publicJwk;
  };

  const handle = async (url: string, init?: RequestInit): Promise<Response | undefined> => {
    const u = new URL(url);
    if (u.origin + u.pathname === `${base}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/jwks`,
      });
    }
    if (u.origin + u.pathname === `${base}/jwks`) {
      const jwk = await ensureJwk();
      return Response.json({ keys: [jwk] });
    }
    if (u.origin + u.pathname === `${base}/authorize`) {
      // Not used: createAuthorizationUrl builds the URL; tests extract state/code_challenge from it.
      return new Response('ok');
    }
    if (
      u.origin + u.pathname === `${base}/token` &&
      (init?.method ?? 'GET').toUpperCase() === 'POST'
    ) {
      if (failNextToken) {
        failNextToken = false;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier') ?? '';
      const stored = codes.get(code);
      if (
        !stored ||
        params.get('client_id') !== options.clientId ||
        params.get('client_secret') !== options.clientSecret
      ) {
        return Response.json({ error: 'invalid_client' }, { status: 400 });
      }
      const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
      if (challenge !== stored.codeChallenge) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      codes.delete(code);
      await ensureJwk();
      const now = Math.floor(Date.now() / 1000);
      const nonce = badNonce ? 'wrong-nonce' : stored.nonce;
      badNonce = false;
      const idToken = await new SignJWT({
        email: options.user.email,
        email_verified: options.user.email_verified ?? true,
        name: options.user.name ?? 'Mock User',
        nonce,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'mock-1', typ: 'JWT' })
        .setSubject(options.user.sub)
        .setIssuer(base)
        .setAudience(options.clientId)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      return Response.json({
        access_token: 'mock-access',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: idToken,
      });
    }
    if (u.origin + u.pathname === `${base}/userinfo`) {
      return Response.json({
        sub: options.user.sub,
        email: options.user.email,
        email_verified: options.user.email_verified ?? true,
        name: options.user.name ?? 'Mock User',
      });
    }
    return undefined;
  };

  return {
    issuer: base,
    /** Register an authorization code that the token endpoint will accept. */
    issueCode(input: { codeChallenge: string; nonce: string; redirectUri?: string }): string {
      const code = `code_${codes.size + 1}_${Date.now()}`;
      codes.set(code, {
        codeChallenge: input.codeChallenge,
        nonce: input.nonce,
        redirectUri: input.redirectUri ?? options.redirectUri,
      });
      return code;
    },
    failNextTokenExchange() {
      failNextToken = true;
    },
    issueBadNonceNext() {
      badNonce = true;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = await handle(url, init);
      if (res) return res;
      return new Response('not found', { status: 404 });
    },
  };
}
