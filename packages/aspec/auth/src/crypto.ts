import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { configError } from './errors.js';

/** Returns `bytes` cryptographically random bytes encoded as base64url (no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 of a UTF-8 string as lowercase hex. Used to store opaque tokens. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison that does not leak length through early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function hmacSha256(key: Uint8Array, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** Decodes a secret given as base64 or base64url and checks its minimum length. */
export function decodeKey(value: string | Uint8Array, option: string, minBytes: number): Buffer {
  let buf: Buffer;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
      configError(option, 'must be base64 or base64url encoded');
    }
    buf = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } else {
    buf = Buffer.from(value);
  }
  if (buf.length < minBytes) configError(option, `must decode to at least ${minBytes} bytes`);
  return buf;
}

/**
 * Secret used for HS256 or transaction signing. Accepts raw bytes, or a string that is used as
 * UTF-8 bytes (a random string of at least 32 characters, for example `openssl rand -base64 48`).
 */
export function secretBytes(value: string | Uint8Array, option: string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (buf.length < 32) configError(option, 'must be at least 32 bytes');
  return buf;
}

const ENC_VERSION = 'v1';

export interface FieldEncryptor {
  encrypt(plaintext: string, associatedData: string): string;
  decrypt(ciphertext: string, associatedData: string): string;
}

/**
 * AES-256-GCM field encryption. Output: `v1.<keyId>.<iv>.<ciphertext+tag>` (base64url parts).
 * The associated data (for example the account ID) binds a ciphertext to its row.
 * Additional keys are accepted for decryption so the primary key can be rotated.
 */
export function createFieldEncryptor(
  primary: Uint8Array,
  previous: readonly Uint8Array[] = [],
): FieldEncryptor {
  const keys = new Map<string, Buffer>();
  const primaryBuf = Buffer.from(primary);
  if (primaryBuf.length !== 32) configError('encryptionKey', 'must be exactly 32 bytes');
  const keyId = (k: Buffer) => createHash('sha256').update(k).digest('hex').slice(0, 8);
  const primaryId = keyId(primaryBuf);
  keys.set(primaryId, primaryBuf);
  for (const [i, k] of previous.entries()) {
    const buf = Buffer.from(k);
    if (buf.length !== 32) configError(`previousEncryptionKeys[${i}]`, 'must be exactly 32 bytes');
    keys.set(keyId(buf), buf);
  }
  return {
    encrypt(plaintext, associatedData) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', primaryBuf, iv);
      cipher.setAAD(Buffer.from(associatedData, 'utf8'));
      const ct = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `${ENC_VERSION}.${primaryId}.${iv.toString('base64url')}.${ct.toString('base64url')}`;
    },
    decrypt(ciphertext, associatedData) {
      const parts = ciphertext.split('.');
      if (parts.length !== 4 || parts[0] !== ENC_VERSION) throw new Error('Unsupported ciphertext');
      const key = keys.get(parts[1] as string);
      if (!key) throw new Error('No key available for ciphertext');
      const iv = Buffer.from(parts[2] as string, 'base64url');
      const data = Buffer.from(parts[3] as string, 'base64url');
      if (iv.length !== 12 || data.length < 16) throw new Error('Malformed ciphertext');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([
        decipher.update(data.subarray(0, data.length - 16)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (authenticator app format). */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
