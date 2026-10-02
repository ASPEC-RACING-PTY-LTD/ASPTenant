import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** UUID version 7 (time ordered, 74 random bits) built from `crypto.randomBytes`. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 256 bits of randomness, base64url encoded. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Tokens have the form `<prefix>_<recordId>.<secret>`. The record ID is used for lookup;
 * only the SHA-256 hash of the full token is stored and it is compared in constant time.
 */
export function issueToken(prefix: string, recordId: string): { token: string; hash: string } {
  const token = `${prefix}_${recordId}.${randomSecret()}`;
  return { token, hash: sha256Hex(token) };
}

/** Record IDs embedded in tokens must match this pattern. */
export const TOKEN_RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^([a-z]+)_([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{20,128})$/;

export function parseToken(prefix: string, token: unknown): { recordId: string } | null {
  if (typeof token !== 'string' || token.length > 300) return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match || match[1] !== prefix || match[2] === undefined) return null;
  return { recordId: match[2] };
}

export function verifyTokenHash(token: string, storedHash: string): boolean {
  return constantTimeEqualHex(sha256Hex(token), storedHash);
}
