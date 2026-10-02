import { configError } from './errors.js';
import { parseAllowedOrigins } from './http.js';
import type { AccessTokenSigning } from './tokens.js';

export interface AuthEnv {
  /** AUTH_SECRET: at least 32 bytes; HS256 access token signing when no private key is set. */
  secret?: string;
  /** AUTH_ENCRYPTION_KEY: base64 32-byte key for TOTP secret encryption. */
  encryptionKey?: string;
  /** AUTH_JWT_PRIVATE_KEY: PEM (PKCS#8) or JWK JSON for EdDSA or ES256 access tokens. */
  jwtPrivateKey?: string;
  /** AUTH_JWT_ALG: EdDSA or ES256 when AUTH_JWT_PRIVATE_KEY is set. Default EdDSA. */
  jwtAlg: 'EdDSA' | 'ES256';
  /** AUTH_JWT_KID: optional key ID. */
  jwtKid?: string;
  /** AUTH_APP_URL: public base URL of the application (links and OIDC redirect URIs). */
  appUrl?: string;
  /** AUTH_ALLOWED_ORIGINS: comma-separated origins for CSRF origin checks. */
  allowedOrigins: string[];
  /** AUTH_WEBAUTHN_RP_ID: relying party ID (registrable domain, for example example.com). */
  webauthnRpId?: string;
  /** AUTH_WEBAUTHN_RP_NAME: relying party display name. */
  webauthnRpName?: string;
  /** AUTH_WEBAUTHN_ORIGIN: comma-separated expected origins. */
  webauthnOrigins: string[];
}

type Env = Record<string, string | undefined>;

const opt = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

/** Reads and validates the AUTH_* environment variables documented in docs/configure.md. */
export function readAuthEnv(env: Env): AuthEnv {
  const secret = opt(env, 'AUTH_SECRET');
  if (secret !== undefined && Buffer.byteLength(secret, 'utf8') < 32)
    configError('AUTH_SECRET', 'must be at least 32 bytes');
  const jwtAlg = (opt(env, 'AUTH_JWT_ALG') ?? 'EdDSA') as AuthEnv['jwtAlg'];
  if (jwtAlg !== 'EdDSA' && jwtAlg !== 'ES256')
    configError('AUTH_JWT_ALG', 'must be EdDSA or ES256');
  const out: AuthEnv = {
    jwtAlg,
    allowedOrigins: parseAllowedOrigins(opt(env, 'AUTH_ALLOWED_ORIGINS')),
    webauthnOrigins: parseAllowedOrigins(opt(env, 'AUTH_WEBAUTHN_ORIGIN')),
  };
  const assign = <K extends keyof AuthEnv>(key: K, value: AuthEnv[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  assign('secret', secret);
  assign('encryptionKey', opt(env, 'AUTH_ENCRYPTION_KEY'));
  const pem = opt(env, 'AUTH_JWT_PRIVATE_KEY');
  // Allow PEM keys stored on one line with literal \n sequences.
  assign('jwtPrivateKey', pem?.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem);
  assign('jwtKid', opt(env, 'AUTH_JWT_KID'));
  assign('appUrl', opt(env, 'AUTH_APP_URL')?.replace(/\/+$/, ''));
  assign('webauthnRpId', opt(env, 'AUTH_WEBAUTHN_RP_ID'));
  assign('webauthnRpName', opt(env, 'AUTH_WEBAUTHN_RP_NAME'));
  return out;
}

/** Access token signing from the environment: the private key when set, otherwise HS256 with AUTH_SECRET. */
export function signingFromEnv(env: AuthEnv): AccessTokenSigning {
  if (env.jwtPrivateKey) {
    return {
      alg: env.jwtAlg,
      privateKey: env.jwtPrivateKey,
      ...(env.jwtKid ? { kid: env.jwtKid } : {}),
    };
  }
  if (!env.secret) configError('AUTH_SECRET', 'is required when AUTH_JWT_PRIVATE_KEY is not set');
  return { alg: 'HS256', secret: env.secret, ...(env.jwtKid ? { kid: env.jwtKid } : {}) };
}
