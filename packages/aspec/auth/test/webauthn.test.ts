import { describe, expect, it } from 'vitest';
import { createWebAuthn } from '../src/webauthn.js';
import { createTestAuth, STRONG_PASSWORD } from './helpers/setup.js';
import { createSoftwareAuthenticator } from './helpers/webauthn-authenticator.js';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

describe('WebAuthn', () => {
  it('registers and authenticates with a software authenticator', async () => {
    const { auth } = createTestAuth();
    const reg = await auth.register({ email: 'wa@example.com', password: STRONG_PASSWORD });
    const webauthn = createWebAuthn(auth, {
      rpID: RP_ID,
      origins: [ORIGIN],
      userVerification: 'preferred',
    });
    const options = await webauthn.generateRegistrationOptions(reg.account.id);
    const authenticator = createSoftwareAuthenticator();
    const attestation = authenticator.create({
      challenge: options.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const credential = await webauthn.verifyRegistration(reg.account.id, attestation, {
      name: 'Laptop',
    });
    expect(credential.id).toBe(attestation.id);
    expect(credential.name).toBe('Laptop');

    const authOptions = await webauthn.generateAuthenticationOptions({ accountId: reg.account.id });
    const assertion = authenticator.get({
      challenge: authOptions.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const result = await webauthn.verifyAuthentication(assertion);
    expect(result.status).toBe('authenticated');
    if (result.status === 'authenticated') {
      expect(result.account.id).toBe(reg.account.id);
      expect(result.session.authMethod).toBe('webauthn');
    }
  });

  it('rejects a reused challenge', async () => {
    const { auth } = createTestAuth();
    const reg = await auth.register({ email: 'wa2@example.com', password: STRONG_PASSWORD });
    const webauthn = createWebAuthn(auth, {
      rpID: RP_ID,
      origins: [ORIGIN],
      userVerification: 'preferred',
    });
    const options = await webauthn.generateRegistrationOptions(reg.account.id);
    const authenticator = createSoftwareAuthenticator();
    const attestation = authenticator.create({
      challenge: options.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    await webauthn.verifyRegistration(reg.account.id, attestation);
    await expect(webauthn.verifyRegistration(reg.account.id, attestation)).rejects.toMatchObject({
      code: 'AUTH_WEBAUTHN_CHALLENGE_INVALID',
    });
  });

  it('removes credentials', async () => {
    const { auth } = createTestAuth();
    const reg = await auth.register({ email: 'wa3@example.com', password: STRONG_PASSWORD });
    const webauthn = createWebAuthn(auth, {
      rpID: RP_ID,
      origins: [ORIGIN],
      userVerification: 'preferred',
    });
    const options = await webauthn.generateRegistrationOptions(reg.account.id);
    const authenticator = createSoftwareAuthenticator();
    const attestation = authenticator.create({
      challenge: options.challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const credential = await webauthn.verifyRegistration(reg.account.id, attestation);
    expect(await webauthn.removeCredential(reg.account.id, credential.id)).toBe(true);
    expect(await webauthn.listCredentials(reg.account.id)).toHaveLength(0);
  });
});
