import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argumentError, configError } from './errors.js';

/** Base62 alphabet (no ambiguous punctuation). */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Secret-scanning regex for keys produced by this module (default prefix `ak_live_`). */
export const API_KEY_SCAN_REGEX =
  /\b(?:ak_(?:live|test)_[A-Za-z0-9]{8,16}_[A-Za-z0-9]{40,80}|[A-Za-z0-9_]{2,16}_[A-Za-z0-9]{8,16}_[A-Za-z0-9]{40,80})\b/g;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBase62(bytes: Uint8Array): string {
  // Interpret bytes as a big-endian integer and encode in base62.
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  if (value === 0n) return BASE62[0]!;
  let out = '';
  while (value > 0n) {
    const rem = Number(value % 62n);
    out = BASE62[rem]! + out;
    value /= 62n;
  }
  return out;
}

function checksumSuffix(body: string): string {
  const n = crc32(body);
  // 6 base62 chars from 32-bit CRC (enough for offline recognition).
  const bytes = new Uint8Array(4);
  bytes[0] = (n >>> 24) & 0xff;
  bytes[1] = (n >>> 16) & 0xff;
  bytes[2] = (n >>> 8) & 0xff;
  bytes[3] = n & 0xff;
  return toBase62(bytes).padStart(6, '0').slice(-6);
}

export interface KeyParts {
  /** Full plaintext key (returned once). */
  key: string;
  /** Configurable prefix including trailing underscore, e.g. `ak_live_`. */
  prefix: string;
  /** Short public lookup ID. */
  publicId: string;
  /** Secret material (base62) without checksum. */
  secret: string;
  /** CRC32 checksum suffix. */
  checksum: string;
  /** Display prefix shown in UIs (prefix + first chars of publicId). */
  displayPrefix: string;
}

export interface GenerateKeyOptions {
  /** Key prefix including trailing underscore. Default `ak_live_`. */
  prefix?: string;
  /** Length of the public ID in random bytes (encoded as base62). Default 6 (~8 chars). */
  publicIdBytes?: number;
  /** Length of the secret in random bytes. Default 32. */
  secretBytes?: number;
}

const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,20}_$/;

export function assertPrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw configError('prefix', 'must match [A-Za-z][A-Za-z0-9_]{0,20}_');
  }
  return prefix;
}

/** Generates a key: `<prefix><publicId>_<secret><checksum>`. */
export function generateKey(options: GenerateKeyOptions = {}): KeyParts {
  const prefix = assertPrefix(options.prefix ?? 'ak_live_');
  const publicIdBytes = options.publicIdBytes ?? 6;
  const secretBytes = options.secretBytes ?? 32;
  if (!Number.isInteger(publicIdBytes) || publicIdBytes < 4 || publicIdBytes > 12) {
    throw configError('publicIdBytes', 'must be an integer between 4 and 12');
  }
  if (!Number.isInteger(secretBytes) || secretBytes < 16 || secretBytes > 64) {
    throw configError('secretBytes', 'must be an integer between 16 and 64');
  }
  const publicId = toBase62(randomBytes(publicIdBytes));
  const secret = toBase62(randomBytes(secretBytes));
  const body = `${prefix}${publicId}_${secret}`;
  const checksum = checksumSuffix(body);
  const key = `${body}${checksum}`;
  return {
    key,
    prefix,
    publicId,
    secret,
    checksum,
    displayPrefix: `${prefix}${publicId.slice(0, 4)}…`,
  };
}

export interface ParsedKey {
  prefix: string;
  publicId: string;
  secret: string;
  checksum: string;
  /** Body without checksum (`prefix + publicId + _ + secret`). */
  body: string;
  key: string;
}

/**
 * Parses and verifies the offline CRC32 checksum. Returns undefined when the format or
 * checksum is invalid (callers treat this as authentication failure without revealing why).
 */
export function parseKey(raw: string, expectedPrefix?: string): ParsedKey | undefined {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return undefined;
  if (raw.includes('\0') || /\s/.test(raw)) return undefined;
  const lastUnderscore = raw.lastIndexOf('_');
  if (lastUnderscore <= 0) return undefined;
  // Structure: prefix (may contain underscores) + publicId + _ + secret+checksum
  // Find the separator between publicId and secret: the last underscore.
  const beforeSecret = raw.slice(0, lastUnderscore);
  const secretAndChecksum = raw.slice(lastUnderscore + 1);
  if (secretAndChecksum.length < 10) return undefined;
  const checksum = secretAndChecksum.slice(-6);
  const secret = secretAndChecksum.slice(0, -6);
  if (!/^[A-Za-z0-9]+$/.test(secret) || !/^[A-Za-z0-9]+$/.test(checksum)) return undefined;

  // Split prefix and publicId: prefix ends at the underscore before publicId.
  // Prefix is everything through the last trailing underscore of the configured prefix.
  // We locate publicId as the segment immediately before the secret separator.
  const pubSep = beforeSecret.lastIndexOf('_');
  if (pubSep < 0) return undefined;
  // If prefix is `ak_live_`, beforeSecret is `ak_live_<publicId>` and pubSep points at the
  // underscore after `live`. publicId is after that underscore.
  // For multi-segment prefixes we need the configured prefix. When expectedPrefix is set,
  // use it; otherwise take everything up to and including the underscore before publicId
  // only when the publicId segment looks right.
  let prefix: string;
  let publicId: string;
  if (expectedPrefix) {
    if (!beforeSecret.startsWith(expectedPrefix)) return undefined;
    prefix = expectedPrefix;
    publicId = beforeSecret.slice(expectedPrefix.length);
  } else {
    // Heuristic: publicId is the final segment of beforeSecret.
    publicId = beforeSecret.slice(pubSep + 1);
    prefix = beforeSecret.slice(0, pubSep + 1);
  }
  if (!/^[A-Za-z0-9]{6,20}$/.test(publicId)) return undefined;
  if (!PREFIX_PATTERN.test(prefix) && expectedPrefix === undefined) {
    // Allow multi-underscore prefixes like ak_live_
    if (!/^[A-Za-z0-9_]+_$/.test(prefix)) return undefined;
  }

  const body = `${prefix}${publicId}_${secret}`;
  const expected = checksumSuffix(body);
  const a = Buffer.from(checksum);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { prefix, publicId, secret, checksum, body, key: raw };
}

/** HMAC-SHA256(pepper, key) as base64url. */
export function hashKey(pepper: Buffer, key: string): string {
  return createHmac('sha256', pepper).update(key, 'utf8').digest('base64url');
}

/** Constant-time compare of two hash strings. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a dummy compare to keep timing flatter.
    timingSafeEqual(ba.length > 0 ? ba : Buffer.alloc(1), ba.length > 0 ? ba : Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Dummy hash compare used when the public ID is unknown (mitigates timing oracles). */
export function dummyHashCompare(pepper: Buffer): void {
  const dummy = hashKey(pepper, 'ak_live_dummy0000_dummysecretmaterial0000000000000000000000xx');
  hashesEqual(dummy, dummy);
}

export function parsePepper(
  value: string | Buffer | undefined,
  nodeEnv: string | undefined,
): Buffer {
  if (value === undefined || value === '') {
    if (nodeEnv === 'production') {
      throw configError('pepper', 'API_KEYS_PEPPER is required in production (at least 32 bytes)');
    }
    // Dev fallback: deterministic but clearly unsafe. Logged by the caller.
    return Buffer.from('aspec-api-keys-dev-pepper-not-for-production!!', 'utf8');
  }
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  if (buf.length < 32) {
    throw configError('pepper', 'must be at least 32 bytes');
  }
  return buf;
}

export function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw argumentError(name, 'must be a non-empty string');
  }
  return value;
}

/** Rebuilds a plaintext key keeping an existing public ID (used during rotation). */
export function rebuildKeyWithPublicId(
  prefix: string,
  publicId: string,
  secretBytes = 32,
): { key: string; secret: string; displayPrefix: string } {
  const secret = toBase62(randomBytes(secretBytes));
  const body = `${prefix}${publicId}_${secret}`;
  const checksum = checksumSuffix(body);
  return {
    key: `${body}${checksum}`,
    secret,
    displayPrefix: `${prefix}${publicId.slice(0, 4)}…`,
  };
}
