import { NotFoundError } from '@aspec/errors';
import type { VersionRange } from './route.js';

export type VersioningStyle = 'url' | 'header' | 'both';

export interface VersioningOptions {
  /** Default `url`. */
  style?: VersioningStyle;
  /** URL prefix template; `{version}` is replaced. Default `/v{version}`. */
  urlPrefix?: string;
  /** Header name. Default `API-Version`. */
  header?: string;
  /** Supported versions in preference order (newest first recommended). */
  versions: readonly string[];
  /** Default version when none is supplied. Default: first entry in `versions`. */
  defaultVersion?: string;
}

export interface ResolvedVersion {
  version: string;
  /** Path with the version prefix stripped (URL style). */
  path: string;
  /** Response headers to set (Deprecation, Sunset, Link). */
  headers: Record<string, string>;
}

function versionNumber(version: string): number | undefined {
  const n = Number(version);
  return Number.isFinite(n) ? n : undefined;
}

/** Returns true when the route accepts the resolved version. */
export function routeMatchesVersion(
  version: string,
  range: VersionRange | undefined,
  _all: readonly string[],
): boolean {
  if (range === undefined) return true;
  const v = versionNumber(version);
  if (range.min !== undefined) {
    const min = versionNumber(range.min);
    if (v !== undefined && min !== undefined) {
      if (v < min) return false;
    } else if (version < range.min) {
      return false;
    }
  }
  if (range.max !== undefined) {
    const max = versionNumber(range.max);
    if (v !== undefined && max !== undefined) {
      if (v > max) return false;
    } else if (version > range.max) {
      return false;
    }
  }
  return true;
}

/** Builds deprecation-related response headers for a route version range. */
export function deprecationHeaders(range: VersionRange | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const dep = range?.deprecated;
  if (!dep) return headers;
  if (dep.at === true) headers.Deprecation = 'true';
  else if (typeof dep.at === 'string') headers.Deprecation = dep.at;
  if (dep.sunset !== undefined) headers.Sunset = dep.sunset;
  if (dep.link !== undefined) {
    headers.Link = `<${dep.link}>; rel="deprecation"`;
  }
  return headers;
}

/**
 * Resolves the API version from URL prefix and/or `API-Version` header.
 */
export function resolveVersion(
  path: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  options: VersioningOptions,
): ResolvedVersion {
  const style = options.style ?? 'url';
  const headerName = (options.header ?? 'API-Version').toLowerCase();
  const prefixTemplate = options.urlPrefix ?? '/v{version}';
  let version: string | undefined;
  let stripped = path;

  if (style === 'url' || style === 'both') {
    for (const v of options.versions) {
      const prefix = prefixTemplate.replace('{version}', v);
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        version = v;
        stripped = path === prefix ? '/' : path.slice(prefix.length) || '/';
        if (!stripped.startsWith('/')) stripped = `/${stripped}`;
        break;
      }
    }
  }

  const headerVal = headerValue(headers, headerName);
  if (style === 'header' || style === 'both') {
    if (headerVal !== undefined) {
      if (version !== undefined && headerVal !== version) {
        throw new NotFoundError('API version mismatch between URL and header', {
          code: 'API_VERSION_MISMATCH',
        });
      }
      version = headerVal;
    }
  }

  version ??= options.defaultVersion ?? options.versions[0];
  if (version === undefined || !options.versions.includes(version)) {
    throw new NotFoundError('Unsupported API version', {
      code: 'API_UNSUPPORTED_VERSION',
      details: { version, supported: options.versions },
    });
  }

  return { version, path: stripped, headers: { 'API-Version': version } };
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    const v = headers.get(name);
    return v === null ? undefined : v;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}
