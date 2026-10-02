import { OrgsError, validationError } from './errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCHEMA_RE = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'www',
  'mail',
  'static',
  'support',
  'help',
  'status',
  'null',
  'undefined',
  'system',
  'root',
  'public',
  'private',
  'internal',
  'orgs',
  'org',
  'teams',
  'team',
  'me',
  'new',
  'create',
  'settings',
  'login',
  'logout',
  'signup',
  'invite',
  'invitations',
  'tenants',
  'tenant',
  'aspec',
]);

export function normaliseEmail(value: unknown, path = 'email'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError([{ path, message: 'must be a non-empty string' }]);
  }
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_RE.test(email)) {
    throw validationError([{ path, message: 'must be a valid email address' }]);
  }
  return email;
}

export function assertId(value: unknown, path = 'id'): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw validationError([{ path, message: 'must be 1-128 characters of [A-Za-z0-9_-]' }]);
  }
  return value;
}

export function assertRole(value: unknown, path = 'role'): string {
  if (typeof value !== 'string' || !ROLE_RE.test(value)) {
    throw validationError([{ path, message: 'must be a lowercase role key' }]);
  }
  return value;
}

export function assertSlug(value: unknown, path = 'slug'): string {
  if (typeof value !== 'string') {
    throw validationError([{ path, message: 'must be a string' }]);
  }
  const slug = value.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw validationError([
      { path, message: 'must be a URL slug (lowercase letters, digits, hyphens)' },
    ]);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw validationError([{ path, message: `slug "${slug}" is reserved` }]);
  }
  return slug;
}

export function assertSchemaName(value: unknown, path = 'schema'): string {
  if (typeof value !== 'string' || !SCHEMA_RE.test(value)) {
    throw validationError([
      { path, message: 'must be a valid PostgreSQL schema identifier ([a-z][a-z0-9_]*)' },
    ]);
  }
  if (value === 'public' || value === 'pg_catalog' || value.startsWith('pg_')) {
    throw validationError([{ path, message: 'schema name is reserved' }]);
  }
  return value;
}

export function assertName(value: unknown, path = 'name', max = 120): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError([{ path, message: 'must be a non-empty string' }]);
  }
  const name = value.trim();
  if (name.length > max) {
    throw validationError([{ path, message: `must be at most ${max} characters` }]);
  }
  return name;
}

export function assertJsonObject(
  value: unknown,
  path: string,
  maxBytes = 16_384,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError([{ path, message: 'must be a plain object' }]);
  }
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > maxBytes) {
    throw validationError([{ path, message: `must be at most ${maxBytes} bytes` }]);
  }
  return value as Record<string, unknown>;
}

export function positiveDuration(
  option: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1000) {
    throw new OrgsError('ORGS_CONFIG_INVALID', `${option} must be a duration of at least 1000ms`);
  }
  return value;
}

export function clampLimit(value: unknown, fallback = 50, max = 200): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function slugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!base || RESERVED_SLUGS.has(base) || !SLUG_RE.test(base)) {
    throw validationError([{ path: 'slug', message: 'could not derive a valid slug from name' }]);
  }
  return base;
}
