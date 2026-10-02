import { TestingAssertionError } from './errors.js';

/** A predicate usable anywhere a partial expectation accepts a value. */
export type ValuePredicate = (value: unknown) => boolean;

export interface Mismatch {
  /** JSONPath-like location, for example `$.items[0].name`. */
  path: string;
  message: string;
}

const MAX_FORMAT_LENGTH = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function keyPath(base: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(key)}]`;
}

/** Formats a value for failure messages (JSON where possible, truncated). */
export function formatValue(value: unknown, maxLength = MAX_FORMAT_LENGTH): string {
  let out: string;
  if (value === undefined) out = 'undefined';
  else if (typeof value === 'function') out = `[Function ${value.name || 'anonymous'}]`;
  else if (value instanceof RegExp) out = value.toString();
  else if (typeof value === 'bigint') out = `${value}n`;
  else if (value instanceof Uint8Array) out = `Uint8Array(${value.byteLength})`;
  else {
    try {
      out =
        JSON.stringify(
          value,
          (_k, v: unknown) => {
            if (v instanceof RegExp) return v.toString();
            if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
            if (typeof v === 'bigint') return `${v}n`;
            return v;
          },
          2,
        ) ?? String(value);
    } catch {
      out = String(value);
    }
  }
  return out.length > maxLength
    ? `${out.slice(0, maxLength)}... (${out.length - maxLength} more characters)`
    : out;
}

/**
 * Compares `actual` against a partial expectation and returns every mismatch.
 *
 * Rules: plain objects match when every expected key matches (extra actual keys are ignored;
 * an expected value of `undefined` requires the key to be absent or undefined); arrays match
 * element by element and must have the same length; RegExp values test strings; functions are
 * predicates; Dates compare by time (or ISO string); everything else uses Object.is.
 */
export function partialMismatches(actual: unknown, expected: unknown, path = '$'): Mismatch[] {
  if (typeof expected === 'function') {
    let ok = false;
    try {
      ok = Boolean((expected as ValuePredicate)(actual));
    } catch (err) {
      return [
        { path, message: `predicate threw: ${err instanceof Error ? err.message : String(err)}` },
      ];
    }
    return ok
      ? []
      : [
          {
            path,
            message: `predicate ${formatValue(expected)} rejected ${formatValue(actual, 200)}`,
          },
        ];
  }
  if (expected instanceof RegExp) {
    if (typeof actual !== 'string') {
      return [
        {
          path,
          message: `expected a string matching ${expected}, received ${formatValue(actual, 200)}`,
        },
      ];
    }
    expected.lastIndex = 0;
    return expected.test(actual)
      ? []
      : [{ path, message: `expected ${formatValue(actual, 200)} to match ${expected}` }];
  }
  if (expected instanceof Date) {
    const time =
      actual instanceof Date
        ? actual.getTime()
        : typeof actual === 'string' || typeof actual === 'number'
          ? new Date(actual).getTime()
          : Number.NaN;
    return time === expected.getTime()
      ? []
      : [
          {
            path,
            message: `expected date ${expected.toISOString()}, received ${formatValue(actual, 200)}`,
          },
        ];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [{ path, message: `expected an array, received ${formatValue(actual, 200)}` }];
    }
    const out: Mismatch[] = [];
    if (actual.length !== expected.length) {
      out.push({
        path,
        message: `expected array length ${expected.length}, received ${actual.length}`,
      });
    }
    const n = Math.min(actual.length, expected.length);
    for (let i = 0; i < n; i++)
      out.push(...partialMismatches(actual[i], expected[i], `${path}[${i}]`));
    return out;
  }
  if (isPlainObject(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [{ path, message: `expected an object, received ${formatValue(actual, 200)}` }];
    }
    const out: Mismatch[] = [];
    const record = actual as Record<string, unknown>;
    for (const key of Object.keys(expected)) {
      const exp = expected[key];
      const p = keyPath(path, key);
      if (exp === undefined) {
        if (record[key] !== undefined)
          out.push({
            path: p,
            message: `expected no value, received ${formatValue(record[key], 200)}`,
          });
        continue;
      }
      if (!(key in record)) {
        out.push({ path: p, message: `missing, expected ${formatValue(exp, 200)}` });
        continue;
      }
      out.push(...partialMismatches(record[key], exp, p));
    }
    return out;
  }
  if (Object.is(actual, expected)) return [];
  return [
    {
      path,
      message: `expected ${formatValue(expected, 200)}, received ${formatValue(actual, 200)}`,
    },
  ];
}

/** Restricts `actual` to the shape of `expected` so runner diffs show only relevant keys. */
export function projectToExpected(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return actual.map((item, i) =>
      i < expected.length ? projectToExpected(item, expected[i]) : item,
    );
  }
  if (
    isPlainObject(expected) &&
    actual !== null &&
    typeof actual === 'object' &&
    !Array.isArray(actual)
  ) {
    const record = actual as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key in record) out[key] = projectToExpected(record[key], expected[key]);
    }
    return out;
  }
  return actual;
}

/** Returns true when `actual` satisfies the partial expectation. */
export function matchesPartial(actual: unknown, expected: unknown): boolean {
  return partialMismatches(actual, expected).length === 0;
}

/** Throws a TestingAssertionError listing every mismatch when `actual` does not match. */
export function expectPartial(actual: unknown, expected: unknown, label = 'value'): void {
  const mismatches = partialMismatches(actual, expected);
  if (mismatches.length === 0) return;
  throw new TestingAssertionError(
    `Expected ${label} to match (partial):\n${formatMismatches(mismatches)}\nReceived: ${formatValue(actual)}`,
    projectToExpected(actual, expected),
    expected,
  );
}

export function formatMismatches(mismatches: readonly Mismatch[], limit = 20): string {
  const lines = mismatches.slice(0, limit).map((m) => `  ${m.path}: ${m.message}`);
  if (mismatches.length > limit) lines.push(`  ... and ${mismatches.length - limit} more`);
  return lines.join('\n');
}
