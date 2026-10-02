import { describe, expect, it } from 'vitest';
import { createOidc } from '../src/oidc.js';
import { createMockOidcProvider } from './helpers/oidc-mock.js';
import { createTestAuth, STRONG_PASSWORD } from './helpers/setup.js';

describe('OIDC', () => {
  it('completes authorization code + PKCE against a mock provider', async () => {
    const { auth } = createTestAuth();
    const redirectUri = 'http://127.0.0.1:3000/auth/oidc/mock/callback';
    const mock = createMockOidcProvider({
      issuer: 'http://oidc.test',
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri,
      user: { sub: 'user-1', email: 'oidc@example.com', email_verified: true },
    });
    const oidc = createOidc(auth, {
      redirectUri,
      fetch: mock.fetch,
      providers: [
        {
          id: 'mock',
          kind: 'oidc',
          issuer: mock.issuer,
          clientId: 'client',
          clientSecret: 'secret',
        },
      ],
    });
    const { url, state } = await oidc.createAuthorizationUrl({
      provider: 'mock',
      redirectTo: '/app',
    });
    const authUrl = new URL(url);
    const challenge = authUrl.searchParams.get('code_challenge') as string;
    const nonce = authUrl.searchParams.get('nonce') as string;
    const code = mock.issueCode({ codeChallenge: challenge, nonce });
    const { result, redirectTo } = await oidc.handleCallback({
      provider: 'mock',
      params: { code, state },
      expectedState: state,
    });
    expect(result.status).toBe('authenticated');
    expect(redirectTo).toBe('/app');
    if (result.status === 'authenticated') {
      expect(result.account.email).toBe('oidc@example.com');
    }
  });

  it('rejects bad nonce and provider errors', async () => {
    const { auth } = createTestAuth();
    const redirectUri = 'http://127.0.0.1:3000/auth/oidc/mock/callback';
    const mock = createMockOidcProvider({
      issuer: 'http://oidc.test',
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri,
      user: { sub: 'user-2', email: 'b@example.com', email_verified: true },
    });
    const oidc = createOidc(auth, {
      redirectUri,
      fetch: mock.fetch,
      providers: [
        {
          id: 'mock',
          kind: 'oidc',
          issuer: mock.issuer,
          clientId: 'client',
          clientSecret: 'secret',
        },
      ],
    });
    const started = await oidc.createAuthorizationUrl({ provider: 'mock' });
    const authUrl = new URL(started.url);
    mock.issueBadNonceNext();
    const code = mock.issueCode({
      codeChallenge: authUrl.searchParams.get('code_challenge') as string,
      nonce: authUrl.searchParams.get('nonce') as string,
    });
    await expect(
      oidc.handleCallback({
        provider: 'mock',
        params: { code, state: started.state },
        expectedState: started.state,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_OIDC_ID_TOKEN_INVALID' });

    const started2 = await oidc.createAuthorizationUrl({ provider: 'mock' });
    const authUrl2 = new URL(started2.url);
    mock.failNextTokenExchange();
    const code2 = mock.issueCode({
      codeChallenge: authUrl2.searchParams.get('code_challenge') as string,
      nonce: authUrl2.searchParams.get('nonce') as string,
    });
    await expect(
      oidc.handleCallback({
        provider: 'mock',
        params: { code: code2, state: started2.state },
        expectedState: started2.state,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_OIDC_PROVIDER_ERROR' });
  });

  it('links identities without auto-linking by email by default', async () => {
    const { auth } = createTestAuth();
    await auth.register({ email: 'existing@example.com', password: STRONG_PASSWORD });
    const redirectUri = 'http://127.0.0.1:3000/cb';
    const mock = createMockOidcProvider({
      issuer: 'http://oidc.test',
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri,
      user: { sub: 'user-3', email: 'existing@example.com', email_verified: true },
    });
    const oidc = createOidc(auth, {
      redirectUri,
      fetch: mock.fetch,
      autoLinkByEmail: false,
      providers: [
        {
          id: 'mock',
          kind: 'oidc',
          issuer: mock.issuer,
          clientId: 'client',
          clientSecret: 'secret',
        },
      ],
    });
    const started = await oidc.createAuthorizationUrl({ provider: 'mock' });
    const authUrl = new URL(started.url);
    const code = mock.issueCode({
      codeChallenge: authUrl.searchParams.get('code_challenge') as string,
      nonce: authUrl.searchParams.get('nonce') as string,
    });
    await expect(
      oidc.handleCallback({
        provider: 'mock',
        params: { code, state: started.state },
        expectedState: started.state,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_OIDC_ACCOUNT_CONFLICT' });
  });
});
