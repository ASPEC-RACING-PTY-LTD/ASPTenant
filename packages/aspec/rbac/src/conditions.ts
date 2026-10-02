import { RbacInvalidPolicyError, type RbacValidationIssue } from './errors.js';
import type { ResourceRef, Subject } from './ports.js';

/**
 * Attribute condition language for policies. Conditions are plain JSON, validated against
 * strict structural rules and bounded in depth and size, then compiled to closures. There is
 * no eval, no regular expression built from input, and attribute lookups only follow own
 * properties (never `__proto__`, `constructor` or `prototype`).
 */

export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'in',
  'notIn',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'startsWith',
  'exists',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export type ConditionScalar = string | number | boolean | null;
export type ConditionLiteral = ConditionScalar | readonly ConditionScalar[];
export interface ConditionRef {
  ref: string;
}

export interface AttributeCondition {
  /** Dotted path rooted at `subject`, `resource` or `context`. */
  attr: string;
  op: ConditionOperator;
  /** Literal or `{ ref: path }`. Optional only for `exists` (defaults to true). */
  value?: ConditionLiteral | ConditionRef;
}

export type PolicyCondition =
  | { all: readonly PolicyCondition[] }
  | { any: readonly PolicyCondition[] }
  | { not: PolicyCondition }
  | AttributeCondition;

/** Evaluation input. `context` is the check context plus `scope` and `time`. */
export interface ConditionInput {
  subject: Subject;
  resource?: ResourceRef | undefined;
  context?: Record<string, unknown> | undefined;
}

export interface ConditionLimits {
  /** Maximum nesting depth of combinators. Default 8. */
  maxDepth: number;
  /** Maximum number of nodes (combinators and comparisons). Default 128. */
  maxNodes: number;
  /** Maximum length of array literals. Default 100. */
  maxArrayLength: number;
  /** Maximum length of string literals. Default 512. */
  maxStringLength: number;
}

export const DEFAULT_CONDITION_LIMITS: Readonly<ConditionLimits> = Object.freeze({
  maxDepth: 8,
  maxNodes: 128,
  maxArrayLength: 100,
  maxStringLength: 512,
});

const PATH_ROOTS = new Set(['subject', 'resource', 'context']);
const PATH_SEGMENT = /^(?:[A-Za-z_$][A-Za-z0-9_$-]{0,63}|\d{1,6})$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PATH_SEGMENTS = 10;
const MAX_PATH_LENGTH = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is ConditionScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function pathProblem(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return `must be a non-empty string of at most ${MAX_PATH_LENGTH} characters`;
  }
  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) return `must have at most ${MAX_PATH_SEGMENTS} segments`;
  const root = segments[0] ?? '';
  if (!PATH_ROOTS.has(root)) return 'must start with subject, resource or context';
  for (const segment of segments.slice(1)) {
    if (!PATH_SEGMENT.test(segment)) return `invalid segment "${segment.slice(0, 40)}"`;
    if (FORBIDDEN_SEGMENTS.has(segment)) return `segment "${segment}" is not allowed`;
  }
  return undefined;
}

interface ValidationState {
  nodes: number;
  issues: RbacValidationIssue[];
  limits: ConditionLimits;
}

function validateLiteral(
  value: unknown,
  path: string,
  state: ValidationState,
): ConditionLiteral | undefined {
  if (isScalar(value)) {
    if (typeof value === 'string' && value.length > state.limits.maxStringLength) {
      state.issues.push({
        path,
        message: `string exceeds ${state.limits.maxStringLength} characters`,
      });
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > state.limits.maxArrayLength) {
      state.issues.push({ path, message: `array exceeds ${state.limits.maxArrayLength} items` });
      return undefined;
    }
    const out: ConditionScalar[] = [];
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      if (!isScalar(item)) {
        state.issues.push({ path: `${path}.${i}`, message: 'array items must be scalars' });
        return undefined;
      }
      if (typeof item === 'string' && item.length > state.limits.maxStringLength) {
        state.issues.push({
          path: `${path}.${i}`,
          message: `string exceeds ${state.limits.maxStringLength} characters`,
        });
        return undefined;
      }
      out.push(item);
    }
    return Object.freeze(out);
  }
  state.issues.push({
    path,
    message: 'must be a string, finite number, boolean, null, array of those, or { ref }',
  });
  return undefined;
}

function validateNode(
  input: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): PolicyCondition | undefined {
  state.nodes++;
  if (state.nodes > state.limits.maxNodes) {
    if (state.nodes === state.limits.maxNodes + 1) {
      state.issues.push({ path, message: `condition exceeds ${state.limits.maxNodes} nodes` });
    }
    return undefined;
  }
  if (depth > state.limits.maxDepth) {
    state.issues.push({ path, message: `condition exceeds depth ${state.limits.maxDepth}` });
    return undefined;
  }
  if (!isPlainObject(input)) {
    state.issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const keys = Object.keys(input);
  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    const key = keys[0];
    const list = input[key];
    if (!Array.isArray(list) || list.length === 0) {
      state.issues.push({ path: `${path}.${key}`, message: 'must be a non-empty array' });
      return undefined;
    }
    const children: PolicyCondition[] = [];
    for (let i = 0; i < list.length; i++) {
      const child = validateNode(list[i], `${path}.${key}.${i}`, depth + 1, state);
      if (child) children.push(child);
    }
    if (children.length !== list.length) return undefined;
    const frozen = Object.freeze(children);
    return key === 'all' ? Object.freeze({ all: frozen }) : Object.freeze({ any: frozen });
  }
  if (keys.length === 1 && keys[0] === 'not') {
    const child = validateNode(input.not, `${path}.not`, depth + 1, state);
    return child ? Object.freeze({ not: child }) : undefined;
  }
  if ('attr' in input || 'op' in input) {
    return validateAttribute(input, path, state);
  }
  state.issues.push({
    path,
    message: 'must be { all: [...] }, { any: [...] }, { not: {...} } or { attr, op, value }',
  });
  return undefined;
}

function validateAttribute(
  input: Record<string, unknown>,
  path: string,
  state: ValidationState,
): AttributeCondition | undefined {
  const before = state.issues.length;
  for (const key of Object.keys(input)) {
    if (key !== 'attr' && key !== 'op' && key !== 'value') {
      state.issues.push({ path: `${path}.${key}`, message: 'unknown property' });
    }
  }
  const attrProblem = pathProblem(input.attr);
  if (attrProblem) state.issues.push({ path: `${path}.attr`, message: attrProblem });
  const op = input.op;
  if (typeof op !== 'string' || !(CONDITION_OPERATORS as readonly string[]).includes(op)) {
    state.issues.push({
      path: `${path}.op`,
      message: `must be one of ${CONDITION_OPERATORS.join(', ')}`,
    });
    return undefined;
  }
  const operator = op as ConditionOperator;
  const hasValue = Object.hasOwn(input, 'value');
  let value: ConditionLiteral | ConditionRef | undefined;
  if (!hasValue) {
    if (operator !== 'exists') {
      state.issues.push({ path: `${path}.value`, message: `is required for ${operator}` });
    }
  } else if (isPlainObject(input.value)) {
    const refKeys = Object.keys(input.value);
    if (refKeys.length !== 1 || refKeys[0] !== 'ref') {
      state.issues.push({ path: `${path}.value`, message: 'object values must be { ref: path }' });
    } else {
      const refProblem = pathProblem(input.value.ref);
      if (refProblem) state.issues.push({ path: `${path}.value.ref`, message: refProblem });
      else value = Object.freeze({ ref: input.value.ref as string });
    }
    if (operator === 'exists') {
      state.issues.push({ path: `${path}.value`, message: 'exists takes a boolean value' });
    }
  } else {
    value = validateLiteral(input.value, `${path}.value`, state);
    if (value !== undefined) {
      const typeProblem = literalTypeProblem(operator, value);
      if (typeProblem) state.issues.push({ path: `${path}.value`, message: typeProblem });
    }
  }
  if (state.issues.length > before) return undefined;
  const out: AttributeCondition =
    value === undefined
      ? { attr: input.attr as string, op: operator }
      : { attr: input.attr as string, op: operator, value };
  return Object.freeze(out);
}

function literalTypeProblem(op: ConditionOperator, value: ConditionLiteral): string | undefined {
  switch (op) {
    case 'in':
    case 'notIn':
      return Array.isArray(value) ? undefined : `${op} requires an array value`;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return typeof value === 'number' || typeof value === 'string'
        ? undefined
        : `${op} requires a number or string value`;
    case 'startsWith':
      return typeof value === 'string' ? undefined : 'startsWith requires a string value';
    case 'exists':
      return typeof value === 'boolean' ? undefined : 'exists takes a boolean value';
    case 'contains':
      return Array.isArray(value) ? 'contains requires a scalar value' : undefined;
    case 'eq':
    case 'neq':
      return Array.isArray(value) ? `${op} requires a scalar value` : undefined;
  }
}

/**
 * Validates an untrusted condition and returns a frozen, normalised copy.
 * Throws RbacInvalidPolicyError listing every issue.
 */
export function validateCondition(
  input: unknown,
  limits: Partial<ConditionLimits> = {},
): PolicyCondition {
  const state: ValidationState = {
    nodes: 0,
    issues: [],
    limits: { ...DEFAULT_CONDITION_LIMITS, ...limits },
  };
  const out = validateNode(input, 'condition', 1, state);
  if (!out || state.issues.length > 0) {
    throw new RbacInvalidPolicyError('Invalid policy condition', state.issues.slice(0, 50));
  }
  return out;
}

/** Returns the issues of a condition without throwing. */
export function conditionIssues(
  input: unknown,
  limits: Partial<ConditionLimits> = {},
): RbacValidationIssue[] {
  try {
    validateCondition(input, limits);
    return [];
  } catch (err) {
    if (err instanceof RbacInvalidPolicyError) {
      const details = err.details as { issues: RbacValidationIssue[] };
      return details.issues;
    }
    throw err;
  }
}

const MISSING: unique symbol = Symbol('missing');
type Resolved = unknown | typeof MISSING;

function compilePath(path: string): (input: ConditionInput) => Resolved {
  const segments = path.split('.');
  const root = segments[0] as 'subject' | 'resource' | 'context';
  const rest = segments.slice(1);
  return (input) => {
    let current: unknown = input[root];
    for (const segment of rest) {
      if (Array.isArray(current)) {
        if (!/^\d+$/.test(segment)) return MISSING;
        const index = Number(segment);
        if (index >= current.length) return MISSING;
        current = current[index];
      } else if (typeof current === 'object' && current !== null) {
        if (!Object.hasOwn(current, segment)) return MISSING;
        current = (current as Record<string, unknown>)[segment];
      } else {
        return MISSING;
      }
    }
    return current === undefined ? MISSING : current;
  };
}

type Evaluator = (input: ConditionInput) => boolean;

function compare(op: 'lt' | 'lte' | 'gt' | 'gte', a: unknown, b: unknown): boolean {
  const bothNumbers =
    typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b);
  const bothStrings = typeof a === 'string' && typeof b === 'string';
  if (!bothNumbers && !bothStrings) return false;
  const x = a as number | string;
  const y = b as number | string;
  switch (op) {
    case 'lt':
      return x < y;
    case 'lte':
      return x <= y;
    case 'gt':
      return x > y;
    case 'gte':
      return x >= y;
  }
}

function scalarEquals(a: unknown, b: unknown): boolean {
  return isScalar(a) && isScalar(b) && a === b;
}

function applyOperator(op: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return scalarEquals(actual, expected);
    case 'neq':
      return !scalarEquals(actual, expected);
    case 'in':
      return Array.isArray(expected) && expected.some((item) => scalarEquals(actual, item));
    case 'notIn':
      return Array.isArray(expected) && !expected.some((item) => scalarEquals(actual, item));
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return compare(op, actual, expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.some((item) => scalarEquals(item, expected));
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.includes(expected)
        : false;
    case 'startsWith':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'exists':
      return false;
  }
}

function compileNode(node: PolicyCondition): Evaluator {
  if ('all' in node) {
    const children = node.all.map(compileNode);
    return (input) => children.every((child) => child(input));
  }
  if ('any' in node) {
    const children = node.any.map(compileNode);
    return (input) => children.some((child) => child(input));
  }
  if ('not' in node) {
    const child = compileNode(node.not);
    return (input) => !child(input);
  }
  const read = compilePath(node.attr);
  if (node.op === 'exists') {
    const expected = node.value === undefined ? true : node.value === true;
    return (input) => {
      const actual = read(input);
      const present = actual !== MISSING && actual !== null;
      return present === expected;
    };
  }
  const op = node.op;
  const value = node.value;
  if (isRef(value)) {
    const readRef = compilePath(value.ref);
    return (input) => {
      const actual = read(input);
      if (actual === MISSING) return false;
      const expected = readRef(input);
      if (expected === MISSING) return false;
      return applyOperator(op, actual, expected);
    };
  }
  return (input) => {
    const actual = read(input);
    if (actual === MISSING) return false;
    return applyOperator(op, actual, value);
  };
}

/**
 * Compiles a condition that was produced by validateCondition. Missing attributes make every
 * comparison false except `exists` (which reports absence); `not` then inverts as usual.
 */
export function compileCondition(condition: PolicyCondition): Evaluator {
  return compileNode(condition);
}

/** Validates, compiles and evaluates a condition in one step (convenience for tests and tools). */
export function evaluateCondition(condition: unknown, input: ConditionInput): boolean {
  return compileCondition(validateCondition(condition))(input);
}

/** True when the condition reads any attribute under `context.time`. */
export function conditionUsesTime(condition: PolicyCondition): boolean {
  if ('all' in condition) return condition.all.some(conditionUsesTime);
  if ('any' in condition) return condition.any.some(conditionUsesTime);
  if ('not' in condition) return conditionUsesTime(condition.not);
  const refersToTime = (path: string) =>
    path === 'context.time' || path.startsWith('context.time.');
  if (refersToTime(condition.attr)) return true;
  return isRef(condition.value) && refersToTime(condition.value.ref);
}

function isRef(value: ConditionLiteral | ConditionRef | undefined): value is ConditionRef {
  return isPlainObject(value) && typeof value.ref === 'string';
}
