import { canonicalJson } from './canonical.js';
import type { Redactor } from './redact.js';

/** One field-level difference between `changes.before` and `changes.after`. */
export interface FieldChange {
  /** Dotted path, array indexes in brackets, for example `address.lines[1]`. */
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface DiffResult {
  diff: FieldChange[];
  truncated: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_DEPTH = 32;

/** Converts an arbitrary value to a JSON tree without redaction (cycle-safe). */
function toJsonTree(value: unknown, ancestors: Set<object>, depth: number): Json | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'symbol':
    case 'function':
      return undefined;
  }
  const obj = value as object;
  if (ancestors.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return `[Binary ${(obj as ArrayBuffer).byteLength} bytes]`;
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(obj) || obj instanceof Set) {
      return [...(obj as Iterable<unknown>)].map(
        (v) => toJsonTree(v, ancestors, depth + 1) ?? null,
      );
    }
    let entries: [string, unknown][];
    if (obj instanceof Map) entries = [...obj.entries()].map(([k, v]) => [String(k), v]);
    else if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
      try {
        return (
          toJsonTree((obj as { toJSON: () => unknown }).toJSON(), ancestors, depth + 1) ?? null
        );
      } catch {
        return '[Unserializable]';
      }
    } else entries = Object.entries(obj);
    const out: { [key: string]: Json } = {};
    for (const [k, v] of entries) {
      const j = toJsonTree(v, ancestors, depth + 1);
      if (j !== undefined) out[k] = j;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  if (IDENT.test(key)) return base ? `${base}.${key}` : key;
  return `${base}[${JSON.stringify(key)}]`;
}

/**
 * Computes a field-level diff. Raw values are compared, so a change to a sensitive field is
 * detected, but every value placed in the result is redacted: fields under a sensitive key
 * show only the replacement text.
 */
export function computeDiff(
  before: unknown,
  after: unknown,
  redactor: Redactor,
  maxChanges = 200,
): DiffResult {
  const a = toJsonTree(before, new Set(), 0);
  const b = toJsonTree(after, new Set(), 0);
  const diff: FieldChange[] = [];
  let truncated = false;

  const shown = (v: Json | undefined, sensitive: boolean): unknown => {
    if (v === undefined) return undefined;
    if (sensitive) return v === null ? null : redactor.replacement;
    return redactor.redact(v);
  };

  const push = (change: FieldChange): boolean => {
    if (diff.length >= maxChanges) {
      truncated = true;
      return false;
    }
    diff.push(change);
    return true;
  };

  const visit = (
    x: Json | undefined,
    y: Json | undefined,
    path: string,
    sensitive: boolean,
  ): boolean => {
    if (x === undefined && y === undefined) return true;
    if (x === undefined) {
      const c: FieldChange = { path: path || '$', op: 'added' };
      const v = shown(y, sensitive);
      if (v !== undefined) c.after = v;
      return push(c);
    }
    if (y === undefined) {
      const c: FieldChange = { path: path || '$', op: 'removed' };
      const v = shown(x, sensitive);
      if (v !== undefined) c.before = v;
      return push(c);
    }
    if (!sensitive && isObject(x) && isObject(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys) {
        if (!visit(x[k], y[k], joinPath(path, k), redactor.isSensitiveKey(k))) return false;
      }
      return true;
    }
    if (!sensitive && Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) {
        if (!visit(x[i], y[i], joinPath(path, i), false)) return false;
      }
      return true;
    }
    if (canonicalJson(x) === canonicalJson(y)) return true;
    const c: FieldChange = { path: path || '$', op: 'changed' };
    const bv = shown(x, sensitive);
    const av = shown(y, sensitive);
    if (bv !== undefined) c.before = bv;
    if (av !== undefined) c.after = av;
    return push(c);
  };

  visit(a, b, '', false);
  return { diff, truncated };
}
