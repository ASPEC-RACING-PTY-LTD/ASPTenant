import { configError } from './errors.js';

export interface CookieOptions {
  /** Cookie name. Default `__Host-aspec_session` (or `aspec_session` when `secure` is false). */
  name?: string;
  /** Default true. Only disable for local HTTP development. */
  secure?: boolean;
  /** Default `lax`. */
  sameSite?: 'lax' | 'strict' | 'none';
  /** Default `/`. Must be `/` with the `__Host-` prefix. */
  path?: string;
  /** Not allowed with the `__Host-` prefix. */
  domain?: string;
  /** Persistent cookie (Max-Age set to the session lifetime). Default true. */
  persistent?: boolean;
}

export interface ResolvedCookieOptions {
  name: string;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  domain?: string;
  persistent: boolean;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function resolveCookieOptions(options: CookieOptions = {}): ResolvedCookieOptions {
  const secure = options.secure ?? true;
  const name = options.name ?? (secure ? '__Host-aspec_session' : 'aspec_session');
  const path = options.path ?? '/';
  const sameSite = options.sameSite ?? 'lax';
  if (!COOKIE_NAME.test(name))
    configError('cookie.name', 'contains characters not allowed in cookie names');
  if (!['lax', 'strict', 'none'].includes(sameSite))
    configError('cookie.sameSite', 'must be lax, strict or none');
  if (sameSite === 'none' && !secure)
    configError('cookie.sameSite', 'none requires secure cookies');
  if (name.startsWith('__Host-')) {
    if (!secure) configError('cookie.secure', 'must be true for __Host- cookies');
    if (path !== '/') configError('cookie.path', 'must be / for __Host- cookies');
    if (options.domain) configError('cookie.domain', 'is not allowed for __Host- cookies');
  }
  if (name.startsWith('__Secure-') && !secure)
    configError('cookie.secure', 'must be true for __Secure- cookies');
  if (!path.startsWith('/') || /[;\r\n]/.test(path))
    configError('cookie.path', 'must start with / and not contain ;');
  if (options.domain !== undefined && !/^[A-Za-z0-9.-]+$/.test(options.domain)) {
    configError('cookie.domain', 'is not a valid domain');
  }
  return {
    name,
    secure,
    sameSite,
    path,
    persistent: options.persistent ?? true,
    ...(options.domain ? { domain: options.domain } : {}),
  };
}

export interface SerializeCookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  domain?: string;
}

/** Serialises a Set-Cookie header value. The value must already be cookie-safe (base64url tokens are). */
export function serializeCookie(
  name: string,
  value: string,
  options: SerializeCookieOptions = {},
): string {
  if (!COOKIE_NAME.test(name)) throw new TypeError('Invalid cookie name');
  if (!/^[A-Za-z0-9._~-]*$/.test(value))
    throw new TypeError('Cookie value must be base64url or empty');
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAgeSeconds !== undefined)
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure ?? true) parts.push('Secure');
  const sameSite = options.sameSite ?? 'lax';
  parts.push(`SameSite=${sameSite[0]?.toUpperCase()}${sameSite.slice(1)}`);
  return parts.join('; ');
}

/** Parses a Cookie request header. Later duplicates do not override the first value. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** Set-Cookie value that stores a session token with the configured secure attributes. */
export function sessionCookie(
  options: ResolvedCookieOptions,
  token: string,
  maxAgeSeconds: number,
): string {
  return serializeCookie(options.name, token, {
    httpOnly: true,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.persistent ? { maxAgeSeconds } : {}),
  });
}

/** Set-Cookie value that clears the session cookie. */
export function clearSessionCookie(options: ResolvedCookieOptions): string {
  return serializeCookie(options.name, '', {
    httpOnly: true,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
    ...(options.domain ? { domain: options.domain } : {}),
    maxAgeSeconds: 0,
  });
}
