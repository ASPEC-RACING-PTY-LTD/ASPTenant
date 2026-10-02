import { UsersError, type ValidationIssue, validationError } from './errors.js';
import { isJsonValue, jsonSize } from './fields.js';

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,127}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const ACTIVITY_TYPE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the intent.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Trims and lowercases an email address. Throws USERS_VALIDATION_FAILED when invalid. */
export function normaliseEmail(value: unknown, path = 'email'): string {
  if (typeof value !== 'string') throw validationError([{ path, message: 'must be a string' }]);
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw validationError([{ path, message: 'must be a valid email address' }]);
  }
  return email;
}

export function assertUserId(value: unknown, path = 'id'): string {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    throw validationError([
      { path, message: 'must be 1 to 128 characters: letters, digits and _ . : @ | -' },
    ]);
  }
  return value;
}

export function assertProvider(value: unknown, path: string): string {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) {
    throw validationError([
      { path, message: 'must be 1 to 64 characters: letters, digits, _ . : -' },
    ]);
  }
  return value;
}

export function assertExternalId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    CONTROL_CHARS.test(value)
  ) {
    throw validationError([{ path, message: 'must be 1 to 255 printable characters' }]);
  }
  return value;
}

export function assertRoles(value: unknown, path = 'roles'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw validationError([{ path, message: 'must be an array of at most 20 role keys' }]);
  }
  for (const r of value) {
    if (typeof r !== 'string' || !ROLE_PATTERN.test(r)) {
      throw validationError([
        { path, message: 'role keys must match [A-Za-z0-9_.:-], 1 to 100 characters' },
      ]);
    }
  }
  return [...new Set(value as string[])];
}

export function assertJsonObject(
  value: unknown,
  path: string,
  maxBytes: number,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !isJsonValue(value)) {
    throw validationError([{ path, message: 'must be a JSON object' }]);
  }
  if (jsonSize(value) > maxBytes) {
    throw validationError([{ path, message: `must be at most ${maxBytes} bytes when serialised` }]);
  }
  return structuredClone(value as Record<string, unknown>);
}

export function assertActivityType(value: unknown): string {
  if (typeof value !== 'string' || !ACTIVITY_TYPE_PATTERN.test(value)) {
    throw validationError([{ path: 'type', message: 'must match ^[a-z][a-z0-9_.:-]{0,63}$' }]);
  }
  return value;
}

export function optionalText(
  value: unknown,
  path: string,
  maxLength: number,
  issues: ValidationIssue[],
  options: { allowNewlines?: boolean; minLength?: number } = {},
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string or null' });
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) {
    issues.push({ path, message: `must be at most ${maxLength} characters` });
    return undefined;
  }
  if (options.minLength !== undefined && text.length < options.minLength) {
    issues.push({ path, message: `must be at least ${options.minLength} characters` });
    return undefined;
  }
  const forbidden = options.allowNewlines ? text.replace(/[\r\n\t]/g, '') : text;
  if (CONTROL_CHARS.test(forbidden)) {
    issues.push({ path, message: 'must not contain control characters' });
    return undefined;
  }
  return text;
}

export function validateAvatarUrl(
  value: unknown,
  allowHttp: boolean,
  issues: ValidationIssue[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) {
    issues.push({ path: 'profile.avatarUrl', message: 'must be a URL of at most 2048 characters' });
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ path: 'profile.avatarUrl', message: 'must be an absolute URL' });
    return undefined;
  }
  const okProtocol = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!okProtocol) {
    issues.push({
      path: 'profile.avatarUrl',
      message: allowHttp ? 'must use http or https' : 'must use https',
    });
    return undefined;
  }
  if (url.username || url.password || !url.hostname) {
    issues.push({ path: 'profile.avatarUrl', message: 'must not contain credentials' });
    return undefined;
  }
  return url.toString();
}

/** Returns the canonical BCP 47 tag (via Intl.getCanonicalLocales). */
export function validateLocale(
  value: unknown,
  issues: ValidationIssue[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 35) {
    issues.push({ path: 'profile.locale', message: 'must be a BCP 47 language tag' });
    return undefined;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw new RangeError('empty');
    return canonical;
  } catch {
    issues.push({ path: 'profile.locale', message: 'must be a valid BCP 47 language tag' });
    return undefined;
  }
}

/** Validates an IANA time zone with Intl and returns the name Intl resolves. */
export function validateTimezone(
  value: unknown,
  issues: ValidationIssue[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(value)) {
    issues.push({ path: 'profile.timezone', message: 'must be an IANA time zone name' });
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    issues.push({ path: 'profile.timezone', message: 'must be a valid IANA time zone' });
    return undefined;
  }
}

export function positiveDuration(
  option: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UsersError(
      'USERS_CONFIG_INVALID',
      `${option} must be a positive number of milliseconds`,
    );
  }
  return value;
}

export function positiveInt(option: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsersError('USERS_CONFIG_INVALID', `${option} must be a positive integer`);
  }
  return value;
}

export function clampLimit(value: unknown, fallback = 50, max = 200): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw validationError([{ path: 'limit', message: 'must be a positive integer' }]);
  }
  return Math.min(n, max);
}
