import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/errors.js';
import { createTestAuth, encryptionKey, STRONG_PASSWORD } from './helpers/setup.js';

describe('register and login', () => {
  it('registers, verifies email and logs in', async () => {
    const { auth, events } = createTestAuth();
    const reg = await auth.register({ email: 'User@Example.COM', password: STRONG_PASSWORD });
    expect(reg.account.email).toBe('user@example.com');
    expect(reg.verificationToken).toBeTruthy();
    await auth.verifyEmail({ token: reg.verificationToken as string });
    const login = await auth.login({ email: 'user@example.com', password: STRONG_PASSWORD });
    expect(login.status).toBe('authenticated');
    if (login.status !== 'authenticated') return;
    expect(login.sessionToken.length).toBeGreaterThan(20);
    expect(events.some((e) => e.action === 'auth.register')).toBe(true);
    expect(events.some((e) => e.action === 'auth.login.succeeded')).toBe(true);
    const blob = JSON.stringify(events);
    expect(blob).not.toContain(STRONG_PASSWORD);
    expect(blob).not.toContain(login.sessionToken);
  });

  it('does not enumerate password reset', async () => {
    const { auth } = createTestAuth();
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    const known = await auth.requestPasswordReset({ email: 'a@example.com' });
    const unknown = await auth.requestPasswordReset({ email: 'missing@example.com' });
    expect(known.token).toBeTruthy();
    expect(unknown.token).toBeUndefined();
  });

  it('resets password once and invalidates sessions', async () => {
    const { auth } = createTestAuth();
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    const login = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    if (login.status !== 'authenticated') throw new Error('expected auth');
    const { token } = await auth.requestPasswordReset({ email: 'a@example.com' });
    await auth.resetPassword({ token: token as string, newPassword: 'brand-new-password-99' });
    await expect(auth.authenticateSession(login.sessionToken)).rejects.toMatchObject({
      code: 'AUTH_UNAUTHENTICATED',
    });
    await expect(
      auth.resetPassword({ token: token as string, newPassword: 'another-password-99' }),
    ).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    });
    const again = await auth.login({ email: 'a@example.com', password: 'brand-new-password-99' });
    expect(again.status).toBe('authenticated');
  });
});

describe('lockout and rate limiting', () => {
  it('locks after consecutive failures with backoff', async () => {
    const { auth, clock } = createTestAuth({
      lockout: {
        maxFailures: 3,
        baseDurationMs: 60_000,
        factor: 2,
        maxDurationMs: 600_000,
        revealLockedState: 'always',
      },
      rateLimit: { loginPerEmail: 100, loginPerIp: 1000 },
    });
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    for (let i = 0; i < 3; i++) {
      await expect(
        auth.login({ email: 'a@example.com', password: 'wrong-password-xx' }),
      ).rejects.toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    }
    await expect(
      auth.login({ email: 'a@example.com', password: STRONG_PASSWORD }),
    ).rejects.toMatchObject({
      code: 'AUTH_ACCOUNT_LOCKED',
    });
    clock.advance(61_000);
    const ok = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    expect(ok.status).toBe('authenticated');
  });

  it('rate limits login by email', async () => {
    const { auth } = createTestAuth({
      rateLimit: { loginPerEmail: 2, loginPerIp: 1000, windowMs: 900_000 },
    });
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    await expect(
      auth.login({ email: 'a@example.com', password: 'wrong-password-1' }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      auth.login({ email: 'a@example.com', password: 'wrong-password-2' }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      auth.login({ email: 'a@example.com', password: 'wrong-password-3' }),
    ).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMITED',
    });
  });
});

describe('sessions and refresh tokens', () => {
  it('expires idle sessions with an injected clock', async () => {
    const { auth, clock } = createTestAuth({
      session: { idleTimeoutMs: 60_000, absoluteTimeoutMs: 3_600_000, touchIntervalMs: 1 },
    });
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    const login = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    if (login.status !== 'authenticated') throw new Error('expected auth');
    clock.advance(61_000);
    await expect(auth.authenticateSession(login.sessionToken)).rejects.toMatchObject({
      code: 'AUTH_SESSION_EXPIRED',
    });
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const { auth, events } = createTestAuth({
      tokens: {
        signing: { alg: 'HS256', secret: 'x'.repeat(32) },
        issuer: 'https://auth.test',
        audience: 'https://api.test',
        ttlMs: 60_000,
      },
    });
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    const login = await auth.login({
      email: 'a@example.com',
      password: STRONG_PASSWORD,
      issueTokens: true,
    });
    if (login.status !== 'authenticated' || !login.tokens) throw new Error('expected tokens');
    const first = login.tokens.refreshToken;
    const rotated = await auth.refresh(first);
    expect(rotated.tokens.refreshToken).not.toBe(first);
    await expect(auth.refresh(first)).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REUSED' });
    expect(events.some((e) => e.action === 'auth.refresh.reuse_detected')).toBe(true);
    await expect(auth.refresh(rotated.tokens.refreshToken)).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    });
  });

  it('revokes one session and all others', async () => {
    const { auth } = createTestAuth();
    await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    const a = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    const b = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    if (a.status !== 'authenticated' || b.status !== 'authenticated')
      throw new Error('expected auth');
    await auth.revokeSession(a.account.id, a.session.id);
    await expect(auth.authenticateSession(a.sessionToken)).rejects.toBeInstanceOf(AuthError);
    await auth.revokeAllSessions(a.account.id, { exceptSessionId: b.session.id });
    expect((await auth.authenticateSession(b.sessionToken)).session.id).toBe(b.session.id);
  });
});

describe('MFA', () => {
  it('requires TOTP after enrolment and blocks replay', async () => {
    const { auth, clock } = createTestAuth({ mfa: { encryptionKey: encryptionKey() } });
    const { generateTotp, decodeTotpSecret } = await import('../src/totp.js');
    const reg = await auth.register({ email: 'a@example.com', password: STRONG_PASSWORD });
    const enroll = await auth.beginTotpEnrollment(reg.account.id);
    const secret = decodeTotpSecret(enroll.secret);
    const code = generateTotp(secret, clock.now());
    const confirmed = await auth.confirmTotpEnrollment(reg.account.id, code);
    expect(confirmed.recoveryCodes).toHaveLength(10);
    clock.advance(30_000);
    const login = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    expect(login.status).toBe('mfa_required');
    if (login.status !== 'mfa_required') return;
    const stepCode = generateTotp(secret, clock.now());
    const done = await auth.completeMfaChallenge({
      challengeToken: login.challengeToken,
      code: stepCode,
    });
    expect(done.status).toBe('authenticated');
    const login2 = await auth.login({ email: 'a@example.com', password: STRONG_PASSWORD });
    if (login2.status !== 'mfa_required') throw new Error('expected mfa');
    await expect(
      auth.completeMfaChallenge({ challengeToken: login2.challengeToken, code: stepCode }),
    ).rejects.toMatchObject({ code: 'AUTH_MFA_INVALID_CODE' });
  });
});
