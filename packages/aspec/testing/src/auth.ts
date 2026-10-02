import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { invalidOption, TestingError, TestingErrorCode } from './errors.js';
import type { Clock, Subject } from './ports.js';

export type JwtAlgorithm = 'HS256' | 'ES256';

export interface JwtHeader {
  alg: JwtAlgorithm;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export interface SignJwtOptions {
  algorithm?: JwtAlgorithm;
  /** HS256 secret, at least 32 bytes (RFC 7518 section 3.2). */
  secret?: string | Uint8Array;
  /** ES256 private key: KeyObject, PKCS#8 or SEC1 PEM, or a private JWK. */
  privateKey?: KeyObject | string | JsonWebKey;
  keyId?: string;
  issuer?: string;
  subject?: string;
  audience?: string | string[];
  /** Lifetime in seconds (default 3600). `false` omits `exp`. */
  expiresIn?: number | false;
  /** Seconds from now before which the token is not valid. */
  notBefore?: number;
  /** Default: a random UUID. `false` omits `jti`. */
  jwtId?: string | false;
  clock?: Clock;
  header?: Record<string, unknown>;
}

export interface VerifyJwtOptions {
  algorithms?: readonly JwtAlgorithm[];
  secret?: string | Uint8Array;
  /** ES256 public key: KeyObject, SPKI PEM or a public JWK (private keys are accepted too). */
  publicKey?: KeyObject | string | JsonWebKey;
  issuer?: string;
  audience?: string;
  subject?: string;
  clockToleranceSeconds?: number;
  clock?: Clock;
  /** Require `exp` (default true). */
  requireExpiry?: boolean;
}

export interface VerifiedJwt {
  header: JwtHeader;
  payload: JwtClaims;
}

const MAX_TOKEN_LENGTH = 16_384;
const MIN_HS256_SECRET_BYTES = 32;
const systemClock: Clock = { now: () => Date.now() };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function jwtError(reason: string): TestingError {
  return new TestingError(TestingErrorCode.JWT_INVALID, `Invalid JWT: ${reason}`, {
    status: 401,
    expose: true,
  });
}

function secretBytes(secret: string | Uint8Array | undefined, option: string): Buffer {
  if (secret === undefined) throw invalidOption(option, 'an HS256 secret is required');
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (bytes.byteLength < MIN_HS256_SECRET_BYTES) {
    throw invalidOption(option, `HS256 secrets must be at least ${MIN_HS256_SECRET_BYTES} bytes`);
  }
  return bytes;
}

function toPrivateKey(key: KeyObject | string | JsonWebKey | undefined): KeyObject {
  if (key === undefined) throw invalidOption('privateKey', 'an ES256 private key is required');
  let obj: KeyObject;
  if (typeof key === 'string') obj = createPrivateKey(key);
  else if (isKeyObject(key)) obj = key;
  else obj = createPrivateKey({ key, format: 'jwk' });
  assertP256(obj, 'privateKey', 'private');
  return obj;
}

function toPublicKey(key: KeyObject | string | JsonWebKey | undefined): KeyObject {
  if (key === undefined) throw invalidOption('publicKey', 'an ES256 public key is required');
  let obj: KeyObject;
  if (typeof key === 'string') obj = createPublicKey(key);
  else if (isKeyObject(key)) obj = key.type === 'private' ? createPublicKey(key) : key;
  else obj = createPublicKey({ key, format: 'jwk' });
  assertP256(obj, 'publicKey', 'public');
  return obj;
}

function isKeyObject(value: unknown): value is KeyObject {
  return (
    typeof value === 'object' && value !== null && 'asymmetricKeyType' in value && 'export' in value
  );
}

function assertP256(key: KeyObject, option: string, type: 'private' | 'public'): void {
  if (
    key.type !== type ||
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw invalidOption(option, `ES256 requires a P-256 ${type} key`);
  }
}

/** Signs a JWT with HS256 or ES256 using node:crypto. Adds iat, exp (1 hour) and jti by default. */
export function signTestJwt(claims: JwtClaims = {}, options: SignJwtOptions = {}): string {
  const alg = options.algorithm ?? (options.privateKey !== undefined ? 'ES256' : 'HS256');
  if (alg !== 'HS256' && alg !== 'ES256') throw invalidOption('algorithm', 'use HS256 or ES256');
  const nowSec = Math.floor((options.clock ?? systemClock).now() / 1000);
  const payload: JwtClaims = { iat: nowSec, ...claims };
  if (options.issuer !== undefined) payload.iss = options.issuer;
  if (options.subject !== undefined) payload.sub = options.subject;
  if (options.audience !== undefined) payload.aud = options.audience;
  if (options.expiresIn !== false && payload.exp === undefined)
    payload.exp = nowSec + (options.expiresIn ?? 3600);
  if (options.notBefore !== undefined) payload.nbf = nowSec + options.notBefore;
  if (options.jwtId !== false && payload.jti === undefined)
    payload.jti = options.jwtId ?? randomUUID();
  const header: Record<string, unknown> = { ...options.header, alg, typ: 'JWT' };
  if (options.keyId !== undefined) header.kid = options.keyId;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature: Buffer;
  if (alg === 'HS256') {
    signature = createHmac('sha256', secretBytes(options.secret, 'secret'))
      .update(signingInput)
      .digest();
  } else {
    signature = cryptoSign('sha256', Buffer.from(signingInput), {
      key: toPrivateKey(options.privateKey),
      dsaEncoding: 'ieee-p1363',
    });
  }
  return `${signingInput}.${b64url(signature)}`;
}

function parseJson(segment: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw jwtError(`${what} is not valid base64url JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw jwtError(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Decodes a JWT without verifying it. Use only to inspect tokens in assertions. */
export function decodeTestJwt(token: string): VerifiedJwt {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)
    throw jwtError('token is missing or too long');
  const parts = token.split('.');
  if (parts.length !== 3) throw jwtError('expected three dot-separated segments');
  return {
    header: parseJson(parts[0] as string, 'header') as JwtHeader,
    payload: parseJson(parts[1] as string, 'payload') as JwtClaims,
  };
}

/**
 * Verifies signature, algorithm allow-list and time claims. The algorithm is taken from the
 * key material you pass, never trusted from the token header alone (no "none", no confusion).
 */
export function verifyTestJwt(token: string, options: VerifyJwtOptions): VerifiedJwt {
  const { header, payload } = decodeTestJwt(token);
  const allowed = options.algorithms ?? (options.publicKey !== undefined ? ['ES256'] : ['HS256']);
  if (header.alg !== 'HS256' && header.alg !== 'ES256')
    throw jwtError(`unsupported algorithm ${String(header.alg)}`);
  if (!allowed.includes(header.alg)) throw jwtError(`algorithm ${header.alg} is not allowed`);
  const [h, p, s] = token.split('.') as [string, string, string];
  const signingInput = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(s, 'base64url');
  let valid: boolean;
  if (header.alg === 'HS256') {
    const expected = createHmac('sha256', secretBytes(options.secret, 'secret'))
      .update(signingInput)
      .digest();
    valid = expected.byteLength === signature.byteLength && timingSafeEqual(expected, signature);
  } else {
    valid =
      signature.byteLength === 64 &&
      cryptoVerify(
        'sha256',
        signingInput,
        { key: toPublicKey(options.publicKey), dsaEncoding: 'ieee-p1363' },
        signature,
      );
  }
  if (!valid) throw jwtError('signature verification failed');

  const nowSec = (options.clock ?? systemClock).now() / 1000;
  const tolerance = options.clockToleranceSeconds ?? 0;
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== 'number') throw jwtError('exp must be a number');
    if (nowSec - tolerance >= payload.exp) throw jwtError('token has expired');
  } else if (options.requireExpiry ?? true) {
    throw jwtError('exp is required');
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') throw jwtError('nbf must be a number');
    if (nowSec + tolerance < payload.nbf) throw jwtError('token is not yet valid');
  }
  if (options.issuer !== undefined && payload.iss !== options.issuer)
    throw jwtError('issuer mismatch');
  if (options.subject !== undefined && payload.sub !== options.subject)
    throw jwtError('subject mismatch');
  if (options.audience !== undefined) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(options.audience)) throw jwtError('audience mismatch');
  }
  return { header, payload };
}

export interface TestJwtSignerOptions {
  algorithm?: JwtAlgorithm;
  /** HS256 secret. Default: 32 random bytes generated with node:crypto. */
  secret?: string | Uint8Array;
  /** ES256 private key. Default: a fresh P-256 key pair. */
  privateKey?: KeyObject | string | JsonWebKey;
  keyId?: string;
  issuer?: string;
  audience?: string | string[];
  expiresIn?: number;
  clock?: Clock;
}

export interface TestJwtSigner {
  readonly algorithm: JwtAlgorithm;
  readonly keyId: string;
  readonly issuer: string | undefined;
  readonly audience: string | string[] | undefined;
  /** HS256 only: the secret as a Buffer (configure the application under test with it). */
  readonly secret: Buffer | undefined;
  /** ES256 only: the public key as SPKI PEM. */
  readonly publicKeyPem: string | undefined;
  sign(
    claims?: JwtClaims,
    options?: Omit<SignJwtOptions, 'algorithm' | 'secret' | 'privateKey'>,
  ): string;
  /** Signs a token for a Subject: sub, roles, org_id and team_ids claims. */
  signFor(
    subject: Subject,
    claims?: JwtClaims,
    options?: Omit<SignJwtOptions, 'algorithm' | 'secret' | 'privateKey'>,
  ): string;
  verify(
    token: string,
    options?: Omit<VerifyJwtOptions, 'secret' | 'publicKey' | 'algorithms'>,
  ): VerifiedJwt;
  /** JWKS document with the public key (ES256 only; empty for HS256). */
  jwks(): { keys: JsonWebKey[] };
}

/** Creates a signer with generated key material and default issuer and audience claims. */
export function createTestJwtSigner(options: TestJwtSignerOptions = {}): TestJwtSigner {
  const algorithm = options.algorithm ?? (options.privateKey !== undefined ? 'ES256' : 'HS256');
  if (algorithm !== 'HS256' && algorithm !== 'ES256')
    throw invalidOption('algorithm', 'use HS256 or ES256');
  const keyId = options.keyId ?? `test-${randomBytes(6).toString('hex')}`;
  let secret: Buffer | undefined;
  let privateKey: KeyObject | undefined;
  let publicKey: KeyObject | undefined;
  if (algorithm === 'HS256') {
    secret = options.secret === undefined ? randomBytes(32) : secretBytes(options.secret, 'secret');
  } else if (options.privateKey !== undefined) {
    privateKey = toPrivateKey(options.privateKey);
    publicKey = createPublicKey(privateKey);
  } else {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  }
  const base = (): SignJwtOptions => {
    const o: SignJwtOptions = { algorithm, keyId };
    if (secret) o.secret = secret;
    if (privateKey) o.privateKey = privateKey;
    if (options.issuer !== undefined) o.issuer = options.issuer;
    if (options.audience !== undefined) o.audience = options.audience;
    if (options.expiresIn !== undefined) o.expiresIn = options.expiresIn;
    if (options.clock) o.clock = options.clock;
    return o;
  };
  const signer: TestJwtSigner = {
    algorithm,
    keyId,
    issuer: options.issuer,
    audience: options.audience,
    secret,
    publicKeyPem: publicKey?.export({ format: 'pem', type: 'spki' }).toString(),
    sign: (claims = {}, signOptions = {}) => signTestJwt(claims, { ...base(), ...signOptions }),
    signFor(subject, claims = {}, signOptions = {}) {
      const subjectClaims: JwtClaims = { sub: subject.id };
      if (subject.type !== undefined) subjectClaims.sub_type = subject.type;
      if (subject.roles !== undefined) subjectClaims.roles = [...subject.roles];
      if (subject.orgId !== undefined) subjectClaims.org_id = subject.orgId;
      if (subject.teamIds !== undefined) subjectClaims.team_ids = [...subject.teamIds];
      return signTestJwt({ ...subjectClaims, ...claims }, { ...base(), ...signOptions });
    },
    verify(token, verifyOptions = {}) {
      const o: VerifyJwtOptions = { algorithms: [algorithm], ...verifyOptions };
      if (secret) o.secret = secret;
      if (publicKey) o.publicKey = publicKey;
      if (o.issuer === undefined && options.issuer !== undefined) o.issuer = options.issuer;
      if (o.audience === undefined && typeof options.audience === 'string')
        o.audience = options.audience;
      if (o.clock === undefined && options.clock) o.clock = options.clock;
      return verifyTestJwt(token, o);
    },
    jwks() {
      if (!publicKey) return { keys: [] };
      return {
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: keyId, alg: 'ES256', use: 'sig' }],
      };
    },
  };
  return signer;
}

/** `{ authorization: 'Bearer <token>' }` for request headers. */
export function authHeader(token: string, scheme = 'Bearer'): { authorization: string } {
  if (/[\r\n]/.test(token) || /[\s\r\n]/.test(scheme))
    throw invalidOption('token', 'must not contain whitespace or line breaks');
  return { authorization: `${scheme} ${token}` };
}

export type CookieSignatureFormat = 'cookie-signature' | 'express' | 'hono';

/**
 * Signs a cookie value.
 * - `cookie-signature`: `value.<base64 HMAC-SHA256 without padding>` (cookie-signature, @fastify/cookie).
 * - `express`: `s:` plus the cookie-signature format (cookie-parser signed cookies, express-session).
 * - `hono`: `value.<base64 HMAC-SHA256 with padding>` (hono/cookie setSignedCookie).
 */
export function signCookieValue(
  value: string,
  secret: string | Uint8Array,
  format: CookieSignatureFormat = 'cookie-signature',
): string {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (key.byteLength === 0) throw invalidOption('secret', 'must not be empty');
  const mac = createHmac('sha256', key).update(value).digest('base64');
  if (format === 'hono') return `${value}.${mac}`;
  const signed = `${value}.${mac.replace(/=+$/, '')}`;
  if (format === 'express') return `s:${signed}`;
  if (format === 'cookie-signature') return signed;
  throw invalidOption('format', 'use cookie-signature, express or hono');
}

/** Verifies a signed cookie value in constant time and returns the original value, or false. */
export function unsignCookieValue(
  signed: string,
  secret: string | Uint8Array,
  format: CookieSignatureFormat = 'cookie-signature',
): string | false {
  const body =
    format === 'express' ? (signed.startsWith('s:') ? signed.slice(2) : undefined) : signed;
  if (body === undefined) return false;
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return false;
  const value = body.slice(0, dot);
  const expected = Buffer.from(signCookieValue(value, secret, format));
  const actual = Buffer.from(signed);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
    ? value
    : false;
}

export interface CookieAttributes {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface SessionCookieOptions extends CookieAttributes {
  name: string;
  value: string;
  /** Sign the value with this secret. */
  secret?: string | Uint8Array;
  format?: CookieSignatureFormat;
}

export interface SessionCookie {
  name: string;
  /** Wire value (signed and URI-encoded). */
  value: string;
  /** `name=value` for a Cookie request header. */
  cookieHeader: string;
  /** Full Set-Cookie header value. */
  setCookieHeader: string;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Builds a session cookie for cookie-based applications (optionally signed). */
export function createSessionCookie(options: SessionCookieOptions): SessionCookie {
  if (!COOKIE_NAME.test(options.name)) throw invalidOption('name', 'is not a valid cookie name');
  const raw =
    options.secret === undefined
      ? options.value
      : signCookieValue(options.value, options.secret, options.format);
  const value = encodeURIComponent(raw);
  const attrs = [`${options.name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.domain) attrs.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) attrs.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) attrs.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly ?? true) attrs.push('HttpOnly');
  if (options.secure) attrs.push('Secure');
  attrs.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return {
    name: options.name,
    value,
    cookieHeader: `${options.name}=${value}`,
    setCookieHeader: attrs.join('; '),
  };
}
