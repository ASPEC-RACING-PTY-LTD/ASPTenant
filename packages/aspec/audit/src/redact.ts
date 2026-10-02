import { AuditError } from './errors.js';

/** Default replacement for redacted values. */
export const REDACTED = '[REDACTED]';

export type KeyPattern = string | RegExp;

export type ValueDetector =
  | 'jwt'
  | 'bearer'
  | 'pem'
  | 'aws-access-key'
  | 'card'
  | 'url-credentials';

export const VALUE_DETECTORS: readonly ValueDetector[] = [
  'jwt',
  'bearer',
  'pem',
  'aws-access-key',
  'card',
  'url-credentials',
];

/** A pattern that redacts matching substrings inside string values. */
export interface ValuePattern {
  name: string;
  /** Global flag is added automatically. */
  pattern: RegExp;
  /** Optional check on the matched text; return false to keep the match. */
  validate?: (match: string) => boolean;
  /** Replacement for a match. Defaults to the redactor replacement. */
  replace?: (match: string, replacement: string) => string;
}

export interface RedactionContext {
  /** Property name holding the value, undefined for array items and the root. */
  key: string | undefined;
  path: readonly (string | number)[];
}

/**
 * Custom redactor. Return undefined to leave the value to the built-in rules, or any other
 * value to replace it (the replacement is not redacted further).
 */
export type CustomRedactor = (value: unknown, context: RedactionContext) => unknown;

export interface RedactorOptions {
  /** Extra sensitive key fragments (matched case-insensitively, ignoring `-` and `_`) or regular expressions. */
  keys?: readonly KeyPattern[];
  /** Replace the built-in key list instead of extending it. Default false. */
  replaceDefaultKeys?: boolean;
  /** Extra value patterns. */
  values?: readonly ValuePattern[];
  /** Built-in value detectors to turn off. */
  disableDetectors?: readonly ValueDetector[];
  custom?: readonly CustomRedactor[];
  /** Replacement text. Default `[REDACTED]`. */
  replacement?: string;
  /** Maximum nesting depth before values are replaced by `[MaxDepth]`. Default 32. */
  maxDepth?: number;
  /** Strings longer than this are truncated. Default 16384. */
  maxStringLength?: number;
  /** Arrays longer than this are truncated. Default 1000. */
  maxArrayLength?: number;
  /** Objects with more keys than this keep only the first keys. Default 1000. */
  maxKeys?: number;
}

export interface Redactor {
  /** Returns a redacted, JSON-safe deep copy of value. Never mutates the input. */
  redact(value: unknown): unknown;
  /** Whether a property name is treated as sensitive. */
  isSensitiveKey(key: string): boolean;
  /** Applies value patterns to one string. */
  redactString(value: string): string;
  readonly replacement: string;
}

/** Key fragments redacted wherever they appear in a normalised key. */
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
  'creditcard',
  'cardnumber',
  'sessionid',
  'hmackey',
  'encryptionkey',
];

/** Short keys redacted only on an exact (normalised) match. */
export const DEFAULT_SENSITIVE_KEYS_EXACT: readonly string[] = [
  'pwd',
  'pin',
  'cvv',
  'cvc',
  'ssn',
  'otp',
  'mfacode',
  'totp',
  'auth',
  'jwt',
  'sid',
];

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const BUILTIN_PATTERNS: Record<ValueDetector, ValuePattern> = {
  jwt: {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
  },
  bearer: {
    name: 'bearer',
    pattern: /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (match, replacement) => `${match.split(/\s+/)[0]} ${replacement}`,
  },
  pem: {
    name: 'pem',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g,
  },
  'aws-access-key': {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  },
  card: {
    name: 'card',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: (match) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  'url-credentials': {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]*:)[^@\s/]+@/gi,
    replace: (match, replacement) => {
      const idx = match.indexOf('://');
      const colon = match.indexOf(':', idx + 3);
      return `${match.slice(0, colon + 1)}${replacement}@`;
    },
  },
};

type WellFormed = { toWellFormed(): string };

/** Makes a string safe for every storage backend: well-formed UTF-16 and no NUL characters. */
export function cleanString(value: string): string {
  const wf = (value as unknown as WellFormed).toWellFormed
    ? (value as unknown as WellFormed).toWellFormed()
    : value;
  return wf.includes('\0') ? wf.split('\0').join('\uFFFD') : wf;
}

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', `redact.${name} must be a positive integer`);
  }
  return value;
}

/** Creates a deep, cycle-safe redactor. Redaction runs before hashing and storage. */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const replacement = options.replacement ?? REDACTED;
  if (typeof replacement !== 'string') {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'redact.replacement must be a string');
  }
  const maxDepth = positiveInt('maxDepth', options.maxDepth, 32);
  const maxStringLength = positiveInt('maxStringLength', options.maxStringLength, 16384);
  const maxArrayLength = positiveInt('maxArrayLength', options.maxArrayLength, 1000);
  const maxKeys = positiveInt('maxKeys', options.maxKeys, 1000);

  const fragments = new Set<string>(
    options.replaceDefaultKeys ? [] : DEFAULT_SENSITIVE_KEY_FRAGMENTS,
  );
  const exact = new Set<string>(options.replaceDefaultKeys ? [] : DEFAULT_SENSITIVE_KEYS_EXACT);
  const regexes: RegExp[] = [];
  for (const k of options.keys ?? []) {
    if (typeof k === 'string') {
      const n = normaliseKey(k);
      if (n.length === 0) continue;
      if (n.length <= 3) exact.add(n);
      else fragments.add(n);
    } else if (k instanceof RegExp) {
      regexes.push(new RegExp(k.source, k.flags.replace(/[gy]/g, '')));
    } else {
      throw new AuditError(
        'AUDIT_INVALID_OPTIONS',
        'redact.keys entries must be strings or RegExp',
      );
    }
  }

  const disabled = new Set(options.disableDetectors ?? []);
  const patterns: ValuePattern[] = [];
  for (const d of VALUE_DETECTORS) {
    if (!disabled.has(d)) patterns.push(BUILTIN_PATTERNS[d]);
  }
  for (const p of options.values ?? []) {
    if (!(p.pattern instanceof RegExp)) {
      throw new AuditError('AUDIT_INVALID_OPTIONS', `redact.values[${p.name}] needs a RegExp`);
    }
    const flags = p.pattern.flags.includes('g') ? p.pattern.flags : `${p.pattern.flags}g`;
    patterns.push({ ...p, pattern: new RegExp(p.pattern.source, flags) });
  }
  const custom = options.custom ?? [];

  const keyCache = new Map<string, boolean>();
  function isSensitiveKey(key: string): boolean {
    const cached = keyCache.get(key);
    if (cached !== undefined) return cached;
    const n = normaliseKey(key);
    let hit = exact.has(n);
    if (!hit) {
      for (const f of fragments) {
        if (n.includes(f)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) hit = regexes.some((r) => r.test(key));
    if (keyCache.size < 10000) keyCache.set(key, hit);
    return hit;
  }

  function redactString(value: string): string {
    let out = cleanString(value);
    for (const p of patterns) {
      p.pattern.lastIndex = 0;
      out = out.replace(p.pattern, (match) => {
        if (p.validate && !p.validate(match)) return match;
        return p.replace ? p.replace(match, replacement) : replacement;
      });
    }
    if (out.length > maxStringLength) {
      out = `${out.slice(0, maxStringLength)}...[truncated ${out.length - maxStringLength} chars]`;
    }
    return out;
  }

  function walk(
    value: unknown,
    key: string | undefined,
    path: (string | number)[],
    ancestors: Set<object>,
    raw: boolean,
  ): unknown {
    if (!raw) {
      for (const fn of custom) {
        const replaced = fn(value, { key, path: [...path] });
        if (replaced !== undefined) return walk(replaced, key, path, new Set(), true);
      }
    }
    if (value === null || value === undefined) return value === null ? null : undefined;
    switch (typeof value) {
      case 'string':
        return raw ? cleanString(value) : redactString(value);
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value;
      case 'bigint':
        return value.toString();
      case 'symbol':
      case 'function':
        return undefined;
    }
    const obj = value as object;
    if (ancestors.has(obj)) return '[Circular]';
    if (path.length >= maxDepth) return '[MaxDepth]';
    if (obj instanceof Date) {
      return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    }
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
      return `[Binary ${(obj as ArrayBuffer).byteLength} bytes]`;
    }
    ancestors.add(obj);
    try {
      if (Array.isArray(obj) || obj instanceof Set) {
        const arr = Array.isArray(obj) ? obj : [...obj];
        const out: unknown[] = [];
        const n = Math.min(arr.length, maxArrayLength);
        for (let i = 0; i < n; i++) {
          path.push(i);
          const v = walk(arr[i], undefined, path, ancestors, raw);
          path.pop();
          out.push(v === undefined ? null : v);
        }
        if (arr.length > maxArrayLength) out.push(`[${arr.length - maxArrayLength} more items]`);
        return out;
      }
      let entries: [string, unknown][];
      if (obj instanceof Map) {
        entries = [...obj.entries()].map(([k, v]) => [String(k), v]);
      } else if (obj instanceof Error) {
        const e = obj as Error & { code?: unknown };
        entries = [
          ['name', e.name],
          ['message', e.message],
        ];
        if (e.code !== undefined) entries.push(['code', e.code]);
      } else if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
        let json: unknown;
        try {
          json = (obj as { toJSON: () => unknown }).toJSON();
        } catch {
          return '[Unserializable]';
        }
        if (json === obj || (typeof json === 'object' && json !== null && ancestors.has(json))) {
          return '[Circular]';
        }
        return walk(json, key, path, ancestors, raw);
      } else {
        entries = Object.entries(obj);
      }
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [k, v] of entries) {
        if (count >= maxKeys) {
          out['[truncated]'] = `${entries.length - maxKeys} more keys`;
          break;
        }
        count++;
        const ck = cleanString(k);
        if (!raw && isSensitiveKey(ck)) {
          if (v === null) out[ck] = null;
          else if (v !== undefined) out[ck] = replacement;
          continue;
        }
        path.push(ck);
        const r = walk(v, ck, path, ancestors, raw);
        path.pop();
        if (r !== undefined) out[ck] = r;
      }
      return out;
    } finally {
      ancestors.delete(obj);
    }
  }

  return {
    replacement,
    isSensitiveKey,
    redactString,
    redact: (value) => walk(value, undefined, [], new Set(), false),
  };
}
