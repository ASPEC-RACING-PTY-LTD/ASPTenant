/** Replacement text for redacted values. */
export const REDACTED = '[REDACTED]';

/**
 * Key fragments that mark a value as sensitive. Keys are normalised (lowercase, only letters and
 * digits) and match when they contain a fragment.
 */
export const DEFAULT_SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'accesskey',
  'credential',
  'sessionid',
  'creditcard',
  'cardnumber',
  'signature',
];

/** Normalised keys that are sensitive only as an exact match (short, ambiguous words). */
export const DEFAULT_SENSITIVE_EXACT_KEYS: readonly string[] = [
  'auth',
  'pwd',
  'pin',
  'otp',
  'cvv',
  'cvc',
  'ssn',
  'jwt',
  'sid',
  'dsn',
];

export interface RedactOptions {
  /** Additional sensitive key fragments or patterns (matched against the raw key). */
  keys?: readonly (string | RegExp)[];
  /** Replacement text. Default `[REDACTED]`. */
  censor?: string;
  /** Maximum object depth before values are replaced by `[Truncated]`. Default 8. */
  maxDepth?: number;
  /** Maximum array items kept. Default 100. */
  maxArrayLength?: number;
  /** Maximum string length kept. Default 4096. */
  maxStringLength?: number;
}

export type Redactor = {
  /** Returns a redacted deep copy of `value` that is safe to serialise. */
  (value: unknown): unknown;
  /** Redacts secrets embedded in a string (JWTs, bearer tokens, URL credentials, key=value). */
  string(value: string): string;
  /** True when a property name is sensitive. */
  isSensitiveKey(key: string): boolean;
};

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const KEY_VALUE_PATTERN =
  /\b(password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|client_secret)=([^&\s"']+)/gi;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Creates a reusable redactor. */
export function createRedactor(options: RedactOptions = {}): Redactor {
  const censor = options.censor ?? REDACTED;
  const maxDepth = options.maxDepth ?? 8;
  const maxArrayLength = options.maxArrayLength ?? 100;
  const maxStringLength = options.maxStringLength ?? 4096;
  const extraFragments: string[] = [];
  const extraPatterns: RegExp[] = [];
  for (const k of options.keys ?? []) {
    if (typeof k === 'string') extraFragments.push(normaliseKey(k));
    else extraPatterns.push(k);
  }
  const fragments = [...DEFAULT_SENSITIVE_KEY_FRAGMENTS, ...extraFragments.filter(Boolean)];
  const exact = new Set(DEFAULT_SENSITIVE_EXACT_KEYS);

  const isSensitiveKey = (key: string): boolean => {
    const n = normaliseKey(key);
    if (exact.has(n)) return true;
    for (const f of fragments) if (n.includes(f)) return true;
    for (const p of extraPatterns) {
      p.lastIndex = 0;
      if (p.test(key)) return true;
    }
    return false;
  };

  const redactString = (value: string): string => {
    let out = value.length > maxStringLength ? `${value.slice(0, maxStringLength)}...` : value;
    out = out.replace(JWT_PATTERN, censor);
    out = out.replace(AUTH_SCHEME_PATTERN, (_m, scheme: string) => `${scheme} ${censor}`);
    out = out.replace(URL_CREDENTIALS_PATTERN, (_m, scheme: string) => `${scheme}${censor}@`);
    out = out.replace(KEY_VALUE_PATTERN, (_m, key: string) => `${key}=${censor}`);
    return out;
  };

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function') return '[Function]';
      if (typeof value === 'symbol') return value.toString();
      return value;
    }
    if (seen.has(value)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated]';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Uint8Array) return `[Binary ${value.byteLength} bytes]`;
    if (value instanceof URL) return redactString(value.toString());
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const out = value.slice(0, maxArrayLength).map((v) => walk(v, depth + 1, seen));
        if (value.length > maxArrayLength) out.push(`[${value.length - maxArrayLength} more]`);
        return out;
      }
      if (value instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of value) {
          const key = String(k);
          out[key] = isSensitiveKey(key) ? censor : walk(v, depth + 1, seen);
        }
        return out;
      }
      if (value instanceof Set) {
        return [...value].slice(0, maxArrayLength).map((v) => walk(v, depth + 1, seen));
      }
      if (value instanceof Error) {
        const e = value as Error & { code?: unknown };
        const out: Record<string, unknown> = { name: e.name, message: redactString(e.message) };
        if (typeof e.code === 'string') out.code = e.code;
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = isSensitiveKey(k) ? censor : walk(v, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  const redactor = ((value: unknown) => walk(value, 0, new WeakSet())) as Redactor;
  redactor.string = redactString;
  redactor.isSensitiveKey = isSensitiveKey;
  return redactor;
}

/** Redacts `value` with the default rules. */
export function redact(value: unknown, options?: RedactOptions): unknown {
  return createRedactor(options)(value);
}
