import type { StandardSchemaV1 } from './standard-schema.js';

/** A path segment: object key or array index. */
export type PathKey = string | number;

/** A normalised validation issue. */
export interface ValidationIssue {
  /** Path from the validated root, for example `['items', 2, 'sku']`. */
  path: PathKey[];
  /** RFC 6901 JSON Pointer for the path, for example `/items/2/sku`. Empty string for the root. */
  pointer: string;
  /** Human readable message (after message customisation). */
  message: string;
  /** Machine readable code, for example `invalid_type`, `too_small` or a custom rule code. */
  code: string;
  /** Expected type or constraint, when the schema library reports it. */
  expected?: string;
  /** JSON type of the received value (never the value itself). */
  received?: string;
}

/** Customises issue messages (for example for translation). Return undefined to keep the message. */
export type MessageFunction = (issue: ValidationIssue) => string | undefined;

/** A message function, or a map from issue code to message text or function. */
export type MessageCustomizer =
  | MessageFunction
  | Readonly<Record<string, string | ((issue: ValidationIssue) => string)>>;

export interface NormalizeOptions {
  messages?: MessageCustomizer | undefined;
  /** Segments prepended to every path (for example `['body']`). */
  pathPrefix?: readonly PathKey[] | undefined;
}

/** Encodes a path as an RFC 6901 JSON Pointer. */
export function toJsonPointer(path: readonly PathKey[]): string {
  let out = '';
  for (const seg of path) out += `/${String(seg).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  return out;
}

/** Decodes an RFC 6901 JSON Pointer into path segments (numeric segments stay strings). */
export function fromJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new TypeError(`Invalid JSON Pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Formats a path for humans: `items[2].sku`. */
export function formatPath(path: readonly PathKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) out += out === '' ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** JSON type name of a value: string, number, integer is not distinguished, array, null, ... */
export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  return typeof value;
}

function toKey(seg: PropertyKey | StandardSchemaV1.PathSegment): PathKey {
  const key = typeof seg === 'object' && seg !== null ? seg.key : seg;
  if (typeof key === 'number') return key;
  if (typeof key === 'symbol') return key.description ?? '';
  return key;
}

function valueAt(root: unknown, path: readonly PathKey[]): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const seg of path) {
    if (current === null || typeof current !== 'object') return { found: false, value: undefined };
    if (current instanceof Map) current = current.get(seg);
    else current = (current as Record<PathKey, unknown>)[seg];
  }
  return { found: true, value: current };
}

function deriveCode(issue: Record<string, unknown>): string {
  if (typeof issue.code === 'string' && issue.code.length > 0) return issue.code;
  // valibot: kind "schema" means a type mismatch; otherwise `type` names the action.
  if (typeof issue.kind === 'string' && typeof issue.type === 'string') {
    return issue.kind === 'schema' ? 'invalid_type' : issue.type;
  }
  if (typeof issue.keyword === 'string') return issue.keyword;
  return 'invalid';
}

function applyMessages(issue: ValidationIssue, messages: MessageCustomizer | undefined): string {
  if (!messages) return issue.message;
  if (typeof messages === 'function') return messages(issue) ?? issue.message;
  const entry = Object.hasOwn(messages, issue.code) ? messages[issue.code] : undefined;
  if (entry === undefined) return issue.message;
  return typeof entry === 'function' ? entry(issue) : entry;
}

/** Converts Standard Schema issues to normalised ValidationIssue objects. */
export function normalizeIssues(
  issues: readonly StandardSchemaV1.Issue[],
  input: unknown,
  options: NormalizeOptions = {},
): ValidationIssue[] {
  const prefix = options.pathPrefix ?? [];
  return issues.map((raw) => {
    const extra = raw as unknown as Record<string, unknown>;
    const localPath = (raw.path ?? []).map(toKey);
    const path = [...prefix, ...localPath];
    const issue: ValidationIssue = {
      path,
      pointer: toJsonPointer(path),
      message: typeof raw.message === 'string' ? raw.message : 'Invalid value',
      code: deriveCode(extra),
    };
    if (typeof extra.expected === 'string') issue.expected = extra.expected;
    if (issue.code === 'invalid_type' || issue.expected !== undefined) {
      const at = valueAt(input, localPath);
      if (at.found) issue.received = typeName(at.value);
    }
    issue.message = applyMessages(issue, options.messages);
    return issue;
  });
}
