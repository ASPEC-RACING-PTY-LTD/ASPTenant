import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AuthError, configError } from './errors.js';

/**
 * Pluggable password hasher. Implement this interface to use argon2 or another algorithm
 * without adding a dependency to @aspec/auth.
 */
export interface PasswordHasher {
  /** Returns a self-describing hash string (PHC format recommended). */
  hash(password: string): Promise<string>;
  /** Verifies in constant time. Returns false (never throws) for malformed or foreign hashes. */
  verify(hash: string, password: string): Promise<boolean>;
  /** True when the hash was produced with weaker or different parameters and should be replaced. */
  needsRehash(hash: string): boolean;
}

export interface ScryptHasherOptions {
  /** log2 of the CPU and memory cost N. Default 17 (N = 131072, OWASP recommendation). */
  logN?: number;
  /** Block size. Default 8. */
  r?: number;
  /** Parallelisation. Default 1. */
  p?: number;
  /** Salt length in bytes. Default 16. */
  saltLength?: number;
  /** Derived key length in bytes. Default 64. */
  keyLength?: number;
}

const PHC_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const N = 2 ** logN;
  // scrypt needs 128 * N * r bytes; allow headroom so OpenSSL does not reject the call.
  const maxmem = 128 * N * r * 2 + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Default hasher: scrypt from node:crypto, run asynchronously on the libuv thread pool.
 * Output format: `$scrypt$ln=17,r=8,p=1$<salt base64>$<hash base64>` (PHC string format).
 */
export function createScryptHasher(options: ScryptHasherOptions = {}): PasswordHasher {
  const logN = options.logN ?? 17;
  const r = options.r ?? 8;
  const p = options.p ?? 1;
  const saltLength = options.saltLength ?? 16;
  const keyLength = options.keyLength ?? 64;
  if (!Number.isInteger(logN) || logN < 10 || logN > 22)
    configError('hasher.logN', 'must be 10 to 22');
  if (!Number.isInteger(r) || r < 1 || r > 32) configError('hasher.r', 'must be 1 to 32');
  if (!Number.isInteger(p) || p < 1 || p > 16) configError('hasher.p', 'must be 1 to 16');
  if (!Number.isInteger(saltLength) || saltLength < 16)
    configError('hasher.saltLength', 'must be at least 16');
  if (!Number.isInteger(keyLength) || keyLength < 32 || keyLength > 128) {
    configError('hasher.keyLength', 'must be 32 to 128');
  }

  return {
    async hash(password) {
      const salt = randomBytes(saltLength);
      const key = await scryptAsync(password, salt, keyLength, logN, r, p);
      return `$scrypt$ln=${logN},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
    },
    async verify(hash, password) {
      const m = PHC_PATTERN.exec(hash);
      if (!m) return false;
      const hLogN = Number(m[1]);
      const hR = Number(m[2]);
      const hP = Number(m[3]);
      if (hLogN < 10 || hLogN > 22 || hR < 1 || hR > 32 || hP < 1 || hP > 16) return false;
      const salt = Buffer.from(m[4] as string, 'base64');
      const expected = Buffer.from(m[5] as string, 'base64');
      if (expected.length < 16 || expected.length > 128) return false;
      try {
        const actual = await scryptAsync(password, salt, expected.length, hLogN, hR, hP);
        return timingSafeEqual(actual, expected);
      } catch {
        return false;
      }
    },
    needsRehash(hash) {
      const m = PHC_PATTERN.exec(hash);
      if (!m) return true;
      const salt = Buffer.from(m[4] as string, 'base64');
      const key = Buffer.from(m[5] as string, 'base64');
      return (
        Number(m[1]) !== logN ||
        Number(m[2]) !== r ||
        Number(m[3]) !== p ||
        salt.length !== saltLength ||
        key.length !== keyLength
      );
    },
  };
}

export interface PasswordPolicyOptions {
  /** Minimum length in Unicode code points. Default 12. */
  minLength?: number;
  /** Maximum length in Unicode code points (limits hashing cost). Default 128. */
  maxLength?: number;
  /**
   * Optional breach check, for example `createHibpChecker()` from `@aspec/auth/hibp`.
   * Return true when the password is known to be compromised.
   */
  isPasswordCompromised?: (password: string) => Promise<boolean>;
}

export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  /** Throws AUTH_PASSWORD_POLICY or AUTH_PASSWORD_COMPROMISED when the password is not acceptable. */
  check(password: unknown): Promise<string>;
}

export function createPasswordPolicy(options: PasswordPolicyOptions = {}): PasswordPolicy {
  const minLength = options.minLength ?? 12;
  const maxLength = options.maxLength ?? 128;
  if (!Number.isInteger(minLength) || minLength < 8)
    configError('passwordPolicy.minLength', 'must be at least 8');
  if (!Number.isInteger(maxLength) || maxLength < minLength || maxLength > 1024) {
    configError('passwordPolicy.maxLength', 'must be between minLength and 1024');
  }
  const compromised = options.isPasswordCompromised;
  return {
    minLength,
    maxLength,
    async check(password) {
      if (typeof password !== 'string') {
        throw new AuthError('AUTH_VALIDATION_FAILED', {
          message: 'A password is required',
          details: [{ field: 'password', message: 'is required' }],
        });
      }
      const length = [...password.normalize('NFKC')].length;
      if (length < minLength || length > maxLength) {
        throw new AuthError('AUTH_PASSWORD_POLICY', {
          message: `Passwords must be between ${minLength} and ${maxLength} characters`,
          details: [{ field: 'password', minLength, maxLength }],
        });
      }
      if (compromised && (await compromised(password))) {
        throw new AuthError('AUTH_PASSWORD_COMPROMISED');
      }
      return password;
    },
  };
}

/** Cheap pre-check applied before verifying a login password (prevents hashing huge inputs). */
export function isPlausiblePassword(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength * 4;
}
