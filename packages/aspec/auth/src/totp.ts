import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Decode, base32Encode } from './crypto.js';
import { configError } from './errors.js';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  /** HMAC algorithm. Default SHA1 (the only one most authenticator apps support). */
  algorithm?: TotpAlgorithm;
  /** Code length, 6 to 8. Default 6. */
  digits?: number;
  /** Time step in seconds. Default 30. */
  period?: number;
  /** Accepted steps before and after the current one. Default 1. */
  window?: number;
}

export interface ResolvedTotpOptions {
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  window: number;
}

export function resolveTotpOptions(options: TotpOptions = {}): ResolvedTotpOptions {
  const algorithm = options.algorithm ?? 'SHA1';
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  const window = options.window ?? 1;
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm))
    configError('mfa.totp.algorithm', 'must be SHA1, SHA256 or SHA512');
  if (!Number.isInteger(digits) || digits < 6 || digits > 8)
    configError('mfa.totp.digits', 'must be 6 to 8');
  if (!Number.isInteger(period) || period < 15 || period > 120)
    configError('mfa.totp.period', 'must be 15 to 120');
  if (!Number.isInteger(window) || window < 0 || window > 3)
    configError('mfa.totp.window', 'must be 0 to 3');
  return { algorithm, digits, period, window };
}

/** HOTP (RFC 4226) value for a counter. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits = 6,
  algorithm: TotpAlgorithm = 'SHA1',
): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), secret).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Time step for an epoch-millisecond timestamp. */
export function totpStep(timeMs: number, period = 30): number {
  return Math.floor(timeMs / 1000 / period);
}

/** TOTP (RFC 6238) code for a timestamp in epoch milliseconds. */
export function generateTotp(
  secret: Uint8Array,
  timeMs: number,
  options: TotpOptions = {},
): string {
  const o = resolveTotpOptions(options);
  return hotp(secret, totpStep(timeMs, o.period), o.digits, o.algorithm);
}

/**
 * Verifies a TOTP code within the configured window. Returns the matched time step (for replay
 * prevention) or null. Every candidate is compared in constant time.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  timeMs: number,
  options: TotpOptions = {},
): number | null {
  const o = resolveTotpOptions(options);
  const normalized = code.replace(/\s/g, '');
  if (!/^\d+$/.test(normalized) || normalized.length !== o.digits) return null;
  const current = totpStep(timeMs, o.period);
  let matched: number | null = null;
  const given = Buffer.from(normalized);
  for (let delta = -o.window; delta <= o.window; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step, o.digits, o.algorithm));
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

/** Generates a random TOTP secret (20 bytes for SHA1, 32 for SHA256, 64 for SHA512). */
export function generateTotpSecret(algorithm: TotpAlgorithm = 'SHA1'): Buffer {
  return randomBytes(algorithm === 'SHA512' ? 64 : algorithm === 'SHA256' ? 32 : 20);
}

export { base32Decode as decodeTotpSecret, base32Encode as encodeTotpSecret };

export interface OtpauthUriInput {
  secret: Uint8Array;
  /** Account label shown in the authenticator app, usually the email. */
  accountName: string;
  /** Issuer (application name). */
  issuer: string;
  options?: TotpOptions;
}

/** Builds an `otpauth://totp/...` URI for QR codes (Google Authenticator key URI format). */
export function buildOtpauthUri(input: OtpauthUriInput): string {
  const o = resolveTotpOptions(input.options);
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: o.algorithm,
    digits: String(o.digits),
    period: String(o.period),
  });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generates human-friendly recovery codes such as `K7QX-M2PA-9RTW-HCZE` (80 bits each). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(16);
    let raw = '';
    for (const b of bytes) raw += RECOVERY_ALPHABET[b & 31];
    codes.push(raw.match(/.{4}/g)?.join('-') ?? raw);
  }
  return codes;
}

/** Canonical form used for hashing recovery codes (uppercase, separators removed). */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
