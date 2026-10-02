import { createPrivateKey, createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { type JWK, jwtVerify, SignJWT } from 'jose';
import { secretBytes } from './crypto.js';
import { AuthError, configError } from './errors.js';

export type AccessTokenSigning =
  | {
      alg: 'EdDSA' | 'ES256';
      /** Private key as a KeyObject, a PEM string (PKCS#8) or a private JWK (object or JSON string). */
      privateKey: KeyObject | string | JWK;
      kid?: string;
    }
  | {
      alg: 'HS256';
      /** Shared secret of at least 32 bytes. */
      secret: string | Uint8Array;
      kid?: string;
    };

export interface AccessTokenOptions {
  signing: AccessTokenSigning;
  issuer: string;
  audience: string | string[];
  /** Access token lifetime. Default 600000 (10 minutes). */
  ttlMs?: number;
  /** Clock tolerance when verifying. Default 5000 ms. */
  clockToleranceMs?: number;
}

export interface AccessTokenClaims {
  /** Account ID. */
  sub: string;
  /** Session ID. */
  sid: string;
  /** Authentication methods used (RFC 8176 style values: pwd, otp, hwk, fed). */
  amr: string[];
  iat: number;
  exp: number;
  jti: string;
}

export interface AccessTokenIssuer {
  readonly alg: 'EdDSA' | 'ES256' | 'HS256';
  readonly ttlMs: number;
  sign(input: {
    accountId: string;
    sessionId: string;
    amr: string[];
    jti: string;
    nowMs: number;
  }): Promise<string>;
  verify(token: string, nowMs: number): Promise<AccessTokenClaims>;
  /** Public JWKS for asymmetric keys (empty for HS256), for resource servers. */
  jwks(): { keys: JWK[] };
}

function toPrivateKey(input: KeyObject | string | JWK, alg: 'EdDSA' | 'ES256'): KeyObject {
  let key: KeyObject;
  try {
    if (typeof input === 'string') {
      const trimmed = input.trim();
      key = trimmed.startsWith('{')
        ? createPrivateKey({ key: JSON.parse(trimmed) as JsonWebKey, format: 'jwk' })
        : createPrivateKey(trimmed);
    } else if ('type' in input && typeof (input as KeyObject).export === 'function') {
      key = input as KeyObject;
    } else {
      key = createPrivateKey({ key: input as JsonWebKey, format: 'jwk' });
    }
  } catch {
    configError('tokens.signing.privateKey', 'could not be parsed as a PEM or JWK private key');
  }
  if (key.type !== 'private') configError('tokens.signing.privateKey', 'must be a private key');
  const ok =
    alg === 'EdDSA'
      ? key.asymmetricKeyType === 'ed25519'
      : key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  if (!ok) configError('tokens.signing.privateKey', `does not match algorithm ${alg}`);
  return key;
}

export function createAccessTokenIssuer(options: AccessTokenOptions): AccessTokenIssuer {
  const ttlMs = options.ttlMs ?? 600_000;
  const tolerance = Math.ceil((options.clockToleranceMs ?? 5_000) / 1000);
  if (!Number.isInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 86_400_000) {
    configError('tokens.accessTokenTtlMs', 'must be between 10000 and 86400000');
  }
  if (!options.issuer) configError('tokens.issuer', 'is required');
  if (!options.audience || (Array.isArray(options.audience) && options.audience.length === 0)) {
    configError('tokens.audience', 'is required');
  }
  const signing = options.signing;
  const kid = signing.kid;
  let signKey: KeyObject | Uint8Array;
  let verifyKey: KeyObject | Uint8Array;
  let publicJwk: JWK | undefined;
  if (signing.alg === 'HS256') {
    signKey = secretBytes(signing.secret, 'tokens.signing.secret');
    verifyKey = signKey;
  } else if (signing.alg === 'EdDSA' || signing.alg === 'ES256') {
    const priv = toPrivateKey(signing.privateKey, signing.alg);
    signKey = priv;
    verifyKey = createPublicKey(priv);
    const exported = (verifyKey as KeyObject).export({ format: 'jwk' }) as JWK;
    publicJwk = { ...exported, alg: signing.alg, use: 'sig', ...(kid ? { kid } : {}) };
  } else {
    configError('tokens.signing.alg', 'must be EdDSA, ES256 or HS256');
  }
  const alg = signing.alg;

  return {
    alg,
    ttlMs,
    async sign({ accountId, sessionId, amr, jti, nowMs }) {
      const iat = Math.floor(nowMs / 1000);
      return new SignJWT({ sid: sessionId, amr })
        .setProtectedHeader({ alg, typ: 'at+jwt', ...(kid ? { kid } : {}) })
        .setSubject(accountId)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt(iat)
        .setExpirationTime(iat + Math.floor(ttlMs / 1000))
        .setJti(jti)
        .sign(signKey);
    },
    async verify(token, nowMs) {
      try {
        const { payload } = await jwtVerify(token, verifyKey, {
          algorithms: [alg],
          issuer: options.issuer,
          audience: options.audience,
          typ: 'at+jwt',
          clockTolerance: tolerance,
          currentDate: new Date(nowMs),
          requiredClaims: ['sub', 'sid', 'exp', 'iat', 'jti'],
        });
        if (
          typeof payload.sub !== 'string' ||
          typeof payload.sid !== 'string' ||
          typeof payload.jti !== 'string'
        ) {
          throw new Error('missing claims');
        }
        return {
          sub: payload.sub,
          sid: payload.sid,
          amr: Array.isArray(payload.amr)
            ? payload.amr.filter((v): v is string => typeof v === 'string')
            : [],
          iat: payload.iat as number,
          exp: payload.exp as number,
          jti: payload.jti,
        };
      } catch (err) {
        throw new AuthError('AUTH_INVALID_TOKEN', { cause: err });
      }
    },
    jwks() {
      return { keys: publicJwk ? [publicJwk] : [] };
    },
  };
}
