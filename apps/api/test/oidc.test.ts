import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequestListener } from '../src/http/server.js';
import {
  createTestContext,
  destroyTestContext,
  json,
  PASSWORD,
  request,
  setupOwner,
  type TestContext,
  userIdOf,
} from './helpers.js';

/** Cookie jar for one browser, keyed by cookie name. */
class Browser {
  private readonly cookies = new Map<string, string>();
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) {
      headers.set(
        'cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    const response = await fetch(url.startsWith('http') ? url : `${this.base}${url}`, {
      ...init,
      headers,
      redirect: 'manual',
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async signIn(email: string, password = PASSWORD) {
    const response = await this.fetch('/auth/login', {
      method: 'POST',
      headers: { origin: this.base, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return (await response.json()) as { status: string; challengeToken?: string };
  }

  post(path: string, body: unknown = {}) {
    return this.fetch(path, {
      method: 'POST',
      headers: { origin: this.base, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function pkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** RFC 6238 code for a base32 secret. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
}

describe('OpenID Connect provider', () => {
  let ctx: TestContext;
  let server: Server;
  let base: string;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await destroyTestContext(ctx);
  });

  async function start() {
    let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end();
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx = await createTestContext({ env: { PUBLIC_URL: base } });
    handler = createRequestListener(ctx.platform, ctx.app);
    const cookie = await setupOwner(ctx, 'alice@contoso.test', 'Contoso');
    const discovery = (await (
      await fetch(`${base}/oidc/.well-known/openid-configuration`)
    ).json()) as Discovery;
    return { cookie, discovery };
  }

  async function register(cookie: string, body: Record<string, unknown>) {
    const response = await request(ctx, '/api/v1/applications', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return json<{ id: string; clientId: string; clientSecret?: string }>(response);
  }

  /** Runs the browser part of an authorization request up to the sign-in page. */
  async function authorize(
    browser: Browser,
    discovery: Discovery,
    params: Record<string, string>,
  ): Promise<{ uid: string; location: string }> {
    const url = new URL(discovery.authorization_endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const start = await browser.fetch(url.toString());
    expect(start.status).toBe(303);
    const location = start.headers.get('location') ?? '';
    const uid = location.split('/').pop() ?? '';
    return { uid, location };
  }

  /** Finishes the interaction and follows the provider back to the redirect URI. */
  async function finish(browser: Browser, uid: string): Promise<URL> {
    const done = await browser.post(`/oidc/interaction/${uid}/continue`);
    expect(done.status).toBe(200);
    const { redirectTo } = (await done.json()) as { redirectTo: string };
    let response = await browser.fetch(redirectTo);
    for (let i = 0; i < 5 && response.status >= 300 && response.status < 400; i += 1) {
      const next = new URL(response.headers.get('location') ?? '', base);
      if (next.origin !== base) return next;
      if (next.pathname.startsWith('/oidc/interaction/')) {
        throw new Error(`another interaction was needed: ${next.pathname}`);
      }
      response = await browser.fetch(next.toString());
    }
    throw new Error(`no redirect back to the client (status ${response.status})`);
  }

  async function verifyIdToken(discovery: Discovery, token: string) {
    const [header = '', payload = '', signature = ''] = token.split('.');
    const { kid, alg } = JSON.parse(Buffer.from(header, 'base64url').toString()) as {
      kid: string;
      alg: string;
    };
    expect(alg).toBe('RS256');
    const jwks = (await (await fetch(discovery.jwks_uri)).json()) as {
      keys: Array<{ kid: string; d?: string }>;
    };
    expect(jwks.keys.every((key) => key.d === undefined)).toBe(true);
    const jwk = jwks.keys.find((key) => key.kid === kid);
    if (!jwk) throw new Error('signing key not published');
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    );
    expect(ok).toBe(true);
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  }

  it('signs a person in to a confidential application with PKCE and a client secret', async () => {
    const { cookie, discovery } = await start();
    expect(discovery.issuer).toBe(`${base}/oidc`);
    expect(discovery.code_challenge_methods_supported).toEqual(['S256']);
    expect(discovery.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining(['client_secret_basic', 'client_secret_post', 'none']),
    );
    const app = await register(cookie, {
      name: 'Portal',
      redirectUris: ['https://portal.example.com/callback'],
    });
    expect(app.clientSecret).toMatch(/^ats_/);
    const listed = await json<{ items: Array<Record<string, unknown>> }>(
      await request(ctx, '/api/v1/applications', { headers: { cookie } }),
    );
    expect(JSON.stringify(listed)).not.toContain(app.clientSecret ?? 'x');

    const browser = new Browser(base);
    const { verifier, challenge } = pkce();
    const redirectUri = 'https://portal.example.com/callback';
    const params = {
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    // Only registered redirect URIs, compared exactly.
    const wrong = await browser.fetch(
      `${discovery.authorization_endpoint}?${new URLSearchParams({ ...params, redirect_uri: 'https://portal.example.com/callback/' })}`,
    );
    expect(wrong.status).toBe(400);

    const { uid, location } = await authorize(browser, discovery, params);
    expect(location).toBe(`/oidc/interaction/${uid}`);
    const page = await browser.fetch(location);
    expect(page.headers.get('location')).toBe(`/sign-in/${uid}`);
    // Not signed in yet.
    expect((await browser.post(`/oidc/interaction/${uid}/continue`)).status).toBe(409);
    expect((await browser.signIn('alice@contoso.test')).status).toBe('authenticated');
    const details = await json<{ application: string; signedInAs: string | null }>(
      await browser.fetch(`/oidc/interaction/${uid}/details`),
    );
    expect(details).toMatchObject({ application: 'Portal', signedInAs: 'alice@contoso.test' });
    // The interaction API only accepts calls from the sign-in page itself.
    const forged = await browser.fetch(`/oidc/interaction/${uid}/continue`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(forged.status).toBe(403);

    const back = await finish(browser, uid);
    expect(back.origin + back.pathname).toBe(redirectUri);
    expect(back.searchParams.get('state')).toBe('state-1');
    const code = back.searchParams.get('code') ?? '';

    const tokenRequest = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(body),
      });
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    const badSecret = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      { authorization: basic('ats_wrong') },
    );
    expect(badSecret.status).toBe(401);
    const tokens = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      { authorization: basic(app.clientSecret ?? '') },
    );
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as { id_token: string; access_token: string };
    const claims = await verifyIdToken(discovery, body.id_token);
    const aliceId = await userIdOf(ctx, cookie);
    const session = await json<{ organisation: { id: string } }>(
      await request(ctx, '/api/v1/session', { headers: { cookie } }),
    );
    expect(claims).toMatchObject({
      iss: `${base}/oidc`,
      aud: app.clientId,
      sub: aliceId,
      nonce: 'nonce-1',
      email: 'alice@contoso.test',
      email_verified: false,
      tid: session.organisation.id,
    });
    expect(typeof claims.name).toBe('string');
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.auth_time).toBe('number');
    const firstAuthTime = Number(claims.auth_time);

    // prompt=login forces a fresh sign-in even though a session exists.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = pkce();
    const again = await authorize(browser, discovery, {
      ...params,
      prompt: 'login',
      nonce: 'nonce-2',
      code_challenge: second.challenge,
    });
    const stale = await json<{ reauthenticate: boolean; signedInAs: string | null }>(
      await browser.fetch(`/oidc/interaction/${again.uid}/details`),
    );
    expect(stale).toMatchObject({ reauthenticate: true, signedInAs: null });
    expect((await browser.post(`/oidc/interaction/${again.uid}/continue`)).status).toBe(409);
    await browser.signIn('alice@contoso.test');
    const fresh = await finish(browser, again.uid);
    // client_secret_post works as well.
    const postTokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: fresh.searchParams.get('code') ?? '',
      redirect_uri: redirectUri,
      code_verifier: second.verifier,
      client_id: app.clientId,
      client_secret: app.clientSecret ?? '',
    });
    expect(postTokens.status).toBe(200);
    const freshClaims = await verifyIdToken(
      discovery,
      ((await postTokens.json()) as { id_token: string }).id_token,
    );
    expect(Number(freshClaims.auth_time)).toBeGreaterThan(firstAuthTime);

    // A rotated secret replaces the old one.
    const rotated = await json<{ clientSecret: string }>(
      await request(ctx, `/api/v1/applications/${app.id}/secret`, {
        method: 'POST',
        headers: { cookie },
      }),
    );
    expect(rotated.clientSecret).not.toBe(app.clientSecret);

    // Signing keys rotate; the earlier key stays published.
    const rotate = await request(ctx, '/api/v1/identity/keys/rotate', {
      method: 'POST',
      headers: { cookie },
    });
    expect(rotate.status).toBe(200);
    const jwks = (await (await fetch(discovery.jwks_uri)).json()) as { keys: unknown[] };
    expect(jwks.keys).toHaveLength(2);
    await verifyIdToken(discovery, body.id_token);
  }, 30_000);

  it('signs a desktop app in as a public client on any loopback port, with PKCE only', async () => {
    const { cookie, discovery } = await start();
    const app = await register(cookie, {
      name: 'Pay desktop',
      redirectUris: ['http://127.0.0.1/callback'],
      clientType: 'public',
    });
    expect(app.clientSecret).toBeUndefined();
    const browser = new Browser(base);
    await browser.signIn('alice@contoso.test');
    const redirectUri = 'http://127.0.0.1:53124/callback';
    const params = {
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: 's',
      nonce: 'n',
    };
    // PKCE is required.
    const withoutPkce = await browser.fetch(
      `${discovery.authorization_endpoint}?${new URLSearchParams(params)}`,
    );
    expect(withoutPkce.headers.get('location') ?? '').toContain('error=invalid_request');
    const { verifier, challenge } = pkce();
    const { uid } = await authorize(browser, discovery, {
      ...params,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const back = await finish(browser, uid);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    const tokens = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: app.clientId,
      }),
    });
    expect(tokens.status).toBe(200);
  }, 30_000);

  it('applies assignment and two-step verification rules per application', async () => {
    const { cookie, discovery } = await start();
    const app = await register(cookie, {
      name: 'Payroll',
      redirectUris: ['https://payroll.example.com/cb'],
    });
    const patch = (body: Record<string, unknown>) =>
      request(ctx, `/api/v1/applications/${app.id}`, {
        method: 'PATCH',
        headers: { cookie },
        body: JSON.stringify(body),
      });
    expect((await patch({ requireAssignment: true })).status).toBe(200);
    const browser = new Browser(base);
    await browser.signIn('alice@contoso.test');
    const params = () => {
      const { challenge } = pkce();
      return {
        client_id: app.clientId,
        redirect_uri: 'https://payroll.example.com/cb',
        response_type: 'code',
        scope: 'openid',
        state: 's',
        nonce: 'n',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      };
    };
    const first = await authorize(browser, discovery, params());
    const refused = await json<{ refusal: string | null }>(
      await browser.fetch(`/oidc/interaction/${first.uid}/details`),
    );
    expect(refused.refusal).toContain('not been given access');
    expect((await browser.post(`/oidc/interaction/${first.uid}/continue`)).status).toBe(403);
    // Cancel goes back to the application with access_denied.
    const abort = await browser.post(`/oidc/interaction/${first.uid}/abort`);
    expect(abort.status).toBe(200);

    const aliceId = await userIdOf(ctx, cookie);
    await patch({ assignments: { users: [aliceId], groups: [] }, requireMfa: true });
    const second = await authorize(browser, discovery, params());
    const needsMfa = await json<{ refusal: string | null }>(
      await browser.fetch(`/oidc/interaction/${second.uid}/details`),
    );
    expect(needsMfa.refusal).toContain('two-step verification');

    // Turn on two-step verification, then sign in with a code.
    const enroll = await json<{ secret: string }>(await browser.post('/auth/mfa/totp/enroll'));
    const confirmed = await browser.post('/auth/mfa/totp/confirm', { code: totp(enroll.secret) });
    expect(confirmed.status).toBe(200);
    const login = await browser.signIn('alice@contoso.test');
    expect(login.status).toBe('mfa_required');
    // The enrolment code cannot be used twice; take the next time step.
    const challenge = await browser.post('/auth/mfa/challenge', {
      challengeToken: login.challengeToken,
      code: totp(enroll.secret, Date.now() + 30_000),
    });
    expect(((await challenge.json()) as { status: string }).status).toBe('authenticated');
    const third = await authorize(browser, discovery, params());
    const allowed = await json<{ refusal: string | null }>(
      await browser.fetch(`/oidc/interaction/${third.uid}/details`),
    );
    expect(allowed.refusal).toBeNull();
    const back = await finish(browser, third.uid);
    expect(back.searchParams.get('code')).toBeTruthy();
  }, 30_000);

  it('explains that sign-in needs the public URL when none is set', async () => {
    server = createServer();
    ctx = await createTestContext({ env: { PUBLIC_URL: '' } });
    ctx.platform.publicUrl = null;
    const listener = createRequestListener(ctx.platform, ctx.app);
    server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/oidc/.well-known/openid-configuration`);
    expect(response.status).toBe(503);
  });
});
