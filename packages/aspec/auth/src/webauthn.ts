import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Auth, LoginResult, RequestContext } from './auth.js';
import { randomToken, sha256Hex } from './crypto.js';
import { AuthError, configError } from './errors.js';
import type { Clock } from './ports.js';
import type { WebAuthnCredentialRecord } from './store.js';

export interface WebAuthnOptions {
  /** Relying party ID (registrable domain, for example `example.com`). */
  rpID: string;
  /** Relying party display name. Default: auth.appName. */
  rpName?: string;
  /** Expected origins (scheme://host[:port]). */
  origins: readonly string[];
  /** Challenge lifetime. Default 300000 (5 minutes). */
  challengeTtlMs?: number;
  /** Prefer discoverable credentials. Default true. */
  residentKey?: 'discouraged' | 'preferred' | 'required';
  /** User verification requirement. Default `preferred`. */
  userVerification?: 'discouraged' | 'preferred' | 'required';
  clock?: Clock;
}

export interface WebAuthnCredentialInfo {
  id: string;
  name: string | null;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface WebAuthnService {
  generateRegistrationOptions(accountId: string): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(
    accountId: string,
    response: unknown,
    input?: { name?: string; context?: RequestContext },
  ): Promise<WebAuthnCredentialInfo>;
  generateAuthenticationOptions(input?: {
    accountId?: string;
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(
    response: unknown,
    input?: { context?: RequestContext; currentSessionToken?: string; issueTokens?: boolean },
  ): Promise<LoginResult>;
  listCredentials(accountId: string): Promise<WebAuthnCredentialInfo[]>;
  removeCredential(
    accountId: string,
    credentialId: string,
    context?: RequestContext,
  ): Promise<boolean>;
}

function asRegistrationResponse(value: unknown): RegistrationResponseJSON {
  if (!value || typeof value !== 'object') throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
  const v = value as RegistrationResponseJSON;
  if (typeof v.id !== 'string' || typeof v.rawId !== 'string' || !v.response) {
    throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
  }
  return v;
}

function asAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
  if (!value || typeof value !== 'object') throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
  const v = value as AuthenticationResponseJSON;
  if (typeof v.id !== 'string' || typeof v.rawId !== 'string' || !v.response) {
    throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
  }
  return v;
}

function toInfo(c: WebAuthnCredentialRecord): WebAuthnCredentialInfo {
  return {
    id: c.id,
    name: c.name,
    deviceType: c.deviceType,
    backedUp: c.backedUp,
    transports: c.transports,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
  };
}

/**
 * Passkey / WebAuthn registration and authentication built on `@simplewebauthn/server`.
 * Challenges are single-use and stored hashed in the AuthStore.
 */
export function createWebAuthn(auth: Auth, options: WebAuthnOptions): WebAuthnService {
  if (!options.rpID || typeof options.rpID !== 'string') configError('rpID', 'is required');
  if (!options.origins?.length) configError('origins', 'must list at least one origin');
  for (const [i, o] of options.origins.entries()) {
    try {
      const u = new URL(o);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad');
    } catch {
      configError(`origins[${i}]`, 'must be an http(s) origin');
    }
  }
  const rpName = options.rpName ?? auth.internals.appName;
  const challengeTtlMs = options.challengeTtlMs ?? 300_000;
  const residentKey = options.residentKey ?? 'preferred';
  const userVerification = options.userVerification ?? 'preferred';
  const clock = options.clock ?? auth.internals.clock;
  const store = auth.internals.store;
  const expectedOrigins = [...options.origins];

  const saveChallenge = async (
    purpose: 'webauthn-registration' | 'webauthn-authentication',
    accountId: string | null,
    challenge: string,
    extra: Record<string, unknown> = {},
  ) => {
    const now = clock.now();
    if (accountId) await store.deleteOneTimeTokens(accountId, purpose);
    await store.createOneTimeToken({
      id: auth.internals.generateId(),
      tokenHash: sha256Hex(challenge),
      purpose,
      accountId,
      data: { challenge, ...extra },
      attempts: 0,
      createdAt: now,
      expiresAt: now + challengeTtlMs,
      usedAt: null,
    });
  };

  const consumeChallenge = async (
    purpose: 'webauthn-registration' | 'webauthn-authentication',
    challenge: string,
  ) => {
    const record = await store.consumeOneTimeToken(sha256Hex(challenge), purpose, clock.now());
    if (!record) throw new AuthError('AUTH_WEBAUTHN_CHALLENGE_INVALID');
    return record;
  };

  return {
    async generateRegistrationOptions(accountId) {
      const account = await store.getAccountById(accountId);
      if (!account) throw new AuthError('AUTH_ACCOUNT_NOT_FOUND');
      const existing = await store.listWebAuthnCredentials(accountId);
      const optionsJSON = await generateRegistrationOptions({
        rpName,
        rpID: options.rpID,
        userName: account.email,
        userID: new TextEncoder().encode(account.id),
        userDisplayName: account.email,
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({
          id: c.id,
          transports: c.transports as AuthenticatorTransport[],
        })),
        authenticatorSelection: {
          residentKey,
          userVerification,
          requireResidentKey: residentKey === 'required',
        },
        supportedAlgorithmIDs: [-7, -257],
      });
      await saveChallenge('webauthn-registration', accountId, optionsJSON.challenge);
      return optionsJSON;
    },

    async verifyRegistration(accountId, response, input = {}) {
      const body = asRegistrationResponse(response);
      const challenge = body.response.clientDataJSON
        ? (
            JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url').toString('utf8')) as {
              challenge?: string;
            }
          ).challenge
        : undefined;
      if (!challenge) throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
      const record = await consumeChallenge('webauthn-registration', challenge);
      if (record.accountId !== accountId) throw new AuthError('AUTH_WEBAUTHN_CHALLENGE_INVALID');

      let verification: VerifiedRegistrationResponse;
      try {
        verification = await verifyRegistrationResponse({
          response: body,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins,
          expectedRPID: options.rpID,
          requireUserVerification: userVerification === 'required',
          requireUserPresence: true,
        });
      } catch (err) {
        throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED', { cause: err });
      }
      if (!verification.verified || !verification.registrationInfo) {
        throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
      }
      const info = verification.registrationInfo;
      const credentialID = info.credential.id;
      const publicKey = Buffer.from(info.credential.publicKey).toString('base64url');
      const now = clock.now();
      const credential: WebAuthnCredentialRecord = {
        id: credentialID,
        accountId,
        publicKey,
        counter: info.credential.counter,
        transports: (body.response.transports ?? []) as string[],
        deviceType: info.credentialDeviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
        backedUp: info.credentialBackedUp,
        name: input.name?.slice(0, 128) ?? null,
        createdAt: now,
        lastUsedAt: null,
      };
      if (!(await store.createWebAuthnCredential(credential))) {
        throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED', {
          message: 'Credential already registered',
        });
      }
      await auth.internals.recordAudit({
        action: 'auth.webauthn.registered',
        outcome: 'success',
        category: 'security',
        ...auth.internals.context(input.context, accountId),
        resource: { type: 'auth.account', id: accountId },
        metadata: { credentialId: credentialID },
      });
      return toInfo(credential);
    },

    async generateAuthenticationOptions(input = {}) {
      let allowCredentials:
        | Array<{ id: string; transports?: AuthenticatorTransport[] }>
        | undefined;
      if (input.accountId) {
        const existing = await store.listWebAuthnCredentials(input.accountId);
        allowCredentials = existing.map((c) => ({
          id: c.id,
          transports: c.transports as AuthenticatorTransport[],
        }));
      }
      const optionsJSON = await generateAuthenticationOptions({
        rpID: options.rpID,
        userVerification,
        ...(allowCredentials ? { allowCredentials } : {}),
      });
      await saveChallenge(
        'webauthn-authentication',
        input.accountId ?? null,
        optionsJSON.challenge,
        {
          ...(input.accountId ? { accountId: input.accountId } : {}),
        },
      );
      return optionsJSON;
    },

    async verifyAuthentication(response, input = {}) {
      const body = asAuthenticationResponse(response);
      const clientData = JSON.parse(
        Buffer.from(body.response.clientDataJSON, 'base64url').toString('utf8'),
      ) as { challenge?: string };
      const challenge = clientData.challenge;
      if (!challenge) throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
      await consumeChallenge('webauthn-authentication', challenge);

      const credential = await store.getWebAuthnCredential(body.id);
      if (!credential) throw new AuthError('AUTH_WEBAUTHN_CREDENTIAL_NOT_FOUND');

      let verification: VerifiedAuthenticationResponse;
      try {
        verification = await verifyAuthenticationResponse({
          response: body,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins,
          expectedRPID: options.rpID,
          credential: {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey, 'base64url'),
            counter: credential.counter,
            transports: credential.transports as AuthenticatorTransport[],
          },
          requireUserVerification: userVerification === 'required',
        });
      } catch (err) {
        throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED', { cause: err });
      }
      if (!verification.verified || !verification.authenticationInfo) {
        throw new AuthError('AUTH_WEBAUTHN_VERIFICATION_FAILED');
      }

      const now = clock.now();
      await store.updateWebAuthnCredentialUsage(
        credential.id,
        verification.authenticationInfo.newCounter,
        now,
        verification.authenticationInfo.credentialDeviceType === 'multiDevice'
          ? true
          : credential.backedUp,
      );

      const mfaVerified = verification.authenticationInfo.userVerified;
      return auth.signIn(credential.accountId, {
        method: 'webauthn',
        mfaVerified,
        enforceMfa: !mfaVerified,
        ...(input.context ? { context: input.context } : {}),
        ...(input.currentSessionToken ? { currentSessionToken: input.currentSessionToken } : {}),
        ...(input.issueTokens !== undefined ? { issueTokens: input.issueTokens } : {}),
      });
    },

    async listCredentials(accountId) {
      const rows = await store.listWebAuthnCredentials(accountId);
      return rows.map(toInfo);
    },

    async removeCredential(accountId, credentialId, context) {
      const ok = await store.deleteWebAuthnCredential(accountId, credentialId);
      if (ok) {
        await auth.internals.recordAudit({
          action: 'auth.webauthn.removed',
          outcome: 'success',
          category: 'security',
          ...auth.internals.context(context, accountId),
          resource: { type: 'auth.account', id: accountId },
          metadata: { credentialId },
        });
      }
      return ok;
    },
  };
}

/** Exported for tests that need a fresh opaque challenge token. */
export function webauthnChallengeToken(): string {
  return randomToken(32);
}
