import { AuthError } from './errors.js';

const MAX_EMAIL_LENGTH = 254;
// Pragmatic check: one @, non-empty local part, dotted domain, no whitespace or control characters.
const EMAIL_PATTERN = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u;

/**
 * Normalises an email address for storage and lookup: Unicode NFKC, trimmed, lowercased.
 * Returns undefined when the value is not a plausible address.
 */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) return undefined;
  if (!EMAIL_PATTERN.test(normalized)) return undefined;
  return normalized;
}

/** Like normalizeEmail but throws AUTH_VALIDATION_FAILED for invalid input. */
export function requireEmail(value: unknown, field = 'email'): string {
  const email = normalizeEmail(value);
  if (!email) {
    throw new AuthError('AUTH_VALIDATION_FAILED', {
      message: 'A valid email address is required',
      details: [{ field, message: 'must be a valid email address' }],
    });
  }
  return email;
}
