import { UsersError, type ValidationIssue } from './errors.js';

/**
 * Minimal Standard Schema v1 interface (https://standardschema.dev). Zod 4, Valibot 1 and
 * ArkType schemas implement it, so any of them can validate a field without an import.
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }>;
    };

interface FieldBase {
  description?: string;
  /** Rejects `null`/absent values when true. Fields with a default are never missing. */
  required?: boolean;
  /**
   * Whether the self-service API may change the field. Defaults: profile fields and
   * preferences `true`, account settings `false`.
   */
  userEditable?: boolean;
}

export interface StringField extends FieldBase {
  type: 'string';
  default?: string;
  minLength?: number;
  maxLength?: number;
  /** Regular expression source (developer supplied, never user input). */
  pattern?: string;
  enum?: readonly string[];
}

export interface NumberField extends FieldBase {
  type: 'number' | 'integer';
  default?: number;
  min?: number;
  max?: number;
}

export interface BooleanField extends FieldBase {
  type: 'boolean';
  default?: boolean;
}

export interface StringArrayField extends FieldBase {
  type: 'string-array';
  default?: readonly string[];
  maxItems?: number;
  itemMaxLength?: number;
  enum?: readonly string[];
}

export interface JsonField extends FieldBase {
  type: 'json';
  default?: unknown;
  /** Maximum serialised size in bytes. Default 4096. */
  maxBytes?: number;
}

export interface SchemaField extends FieldBase {
  /** Any Standard Schema v1 validator. Its output value is stored. */
  schema: StandardSchemaV1;
  default?: unknown;
}

/** JSON-serialisable field definition or a Standard Schema backed definition. */
export type FieldDefinition =
  | StringField
  | NumberField
  | BooleanField
  | StringArrayField
  | JsonField
  | SchemaField;

export type FieldDefinitions = Readonly<Record<string, FieldDefinition>>;

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_JSON_MAX_BYTES = 4096;
const DEFAULT_STRING_MAX = 2000;

function isSchemaField(def: FieldDefinition): def is SchemaField {
  return 'schema' in def;
}

function jsonSize(value: unknown): number {
  const s = JSON.stringify(value);
  return s === undefined ? 0 : Buffer.byteLength(s, 'utf8');
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every((v) =>
        isJsonValue(v, depth + 1),
      );
    }
    default:
      return false;
  }
}

/** Validates definitions at construction time. Throws USERS_CONFIG_INVALID. */
export function assertFieldDefinitions(option: string, defs: FieldDefinitions | undefined): void {
  if (defs === undefined) return;
  if (typeof defs !== 'object' || defs === null) {
    throw new UsersError(
      'USERS_CONFIG_INVALID',
      `${option} must be an object of field definitions`,
    );
  }
  for (const [key, def] of Object.entries(defs)) {
    const where = `${option}.${key}`;
    if (!KEY_PATTERN.test(key)) {
      throw new UsersError('USERS_CONFIG_INVALID', `${where}: invalid field key`);
    }
    if (typeof def !== 'object' || def === null) {
      throw new UsersError('USERS_CONFIG_INVALID', `${where}: definition must be an object`);
    }
    if (isSchemaField(def)) {
      const std = def.schema?.['~standard'];
      if (std?.version !== 1 || typeof std.validate !== 'function') {
        throw new UsersError(
          'USERS_CONFIG_INVALID',
          `${where}.schema must implement Standard Schema v1`,
        );
      }
      continue;
    }
    switch (def.type) {
      case 'string':
        if (def.pattern !== undefined) {
          try {
            new RegExp(def.pattern, 'u');
          } catch {
            throw new UsersError('USERS_CONFIG_INVALID', `${where}.pattern is not a valid regex`);
          }
        }
        break;
      case 'number':
      case 'integer':
      case 'boolean':
      case 'string-array':
        break;
      case 'json':
        if (def.default !== undefined && !isJsonValue(def.default)) {
          throw new UsersError('USERS_CONFIG_INVALID', `${where}.default must be JSON`);
        }
        break;
      default:
        throw new UsersError(
          'USERS_CONFIG_INVALID',
          `${where}.type must be string, number, integer, boolean, string-array or json`,
        );
    }
    if (def.default !== undefined && !isSchemaField(def)) {
      const issues: ValidationIssue[] = [];
      validateBuiltIn(where, def, def.default, issues);
      if (issues.length > 0) {
        throw new UsersError('USERS_CONFIG_INVALID', `${where}.default is invalid`, {
          details: { issues },
        });
      }
    }
  }
}

function validateBuiltIn(
  path: string,
  def: Exclude<FieldDefinition, SchemaField>,
  value: unknown,
  issues: ValidationIssue[],
): unknown {
  switch (def.type) {
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: 'must be a string' });
        return undefined;
      }
      const max = def.maxLength ?? DEFAULT_STRING_MAX;
      if (value.length > max) issues.push({ path, message: `must be at most ${max} characters` });
      else if (def.minLength !== undefined && value.length < def.minLength) {
        issues.push({ path, message: `must be at least ${def.minLength} characters` });
      } else if (def.enum && !def.enum.includes(value)) {
        issues.push({ path, message: `must be one of ${def.enum.join(', ')}` });
      } else if (def.pattern !== undefined && !new RegExp(def.pattern, 'u').test(value)) {
        issues.push({ path, message: 'has an invalid format' });
      }
      return value;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: 'must be a finite number' });
        return undefined;
      }
      if (def.type === 'integer' && !Number.isInteger(value)) {
        issues.push({ path, message: 'must be an integer' });
      } else if (def.min !== undefined && value < def.min) {
        issues.push({ path, message: `must be at least ${def.min}` });
      } else if (def.max !== undefined && value > def.max) {
        issues.push({ path, message: `must be at most ${def.max}` });
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: 'must be a boolean' });
      return value;
    case 'string-array': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        issues.push({ path, message: 'must be an array of strings' });
        return undefined;
      }
      const maxItems = def.maxItems ?? 100;
      const itemMax = def.itemMaxLength ?? 200;
      if (value.length > maxItems)
        issues.push({ path, message: `must have at most ${maxItems} items` });
      else if (value.some((v: string) => v.length > itemMax)) {
        issues.push({ path, message: `items must be at most ${itemMax} characters` });
      } else if (def.enum && value.some((v: string) => !def.enum?.includes(v))) {
        issues.push({ path, message: `items must be one of ${def.enum.join(', ')}` });
      }
      return [...value];
    }
    case 'json': {
      if (!isJsonValue(value)) {
        issues.push({ path, message: 'must be a JSON value' });
        return undefined;
      }
      const max = def.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
      if (jsonSize(value) > max) issues.push({ path, message: `must be at most ${max} bytes` });
      return structuredClone(value);
    }
  }
}

function formatStandardPath(
  base: string,
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined,
): string {
  if (!path || path.length === 0) return base;
  const parts = path.map((p) => String(typeof p === 'object' && p !== null ? p.key : p));
  return `${base}.${parts.join('.')}`;
}

export async function validateFieldValue(
  path: string,
  def: FieldDefinition,
  value: unknown,
  issues: ValidationIssue[],
): Promise<unknown> {
  if (isSchemaField(def)) {
    const result = await def.schema['~standard'].validate(value);
    if (result.issues) {
      for (const issue of result.issues) {
        issues.push({ path: formatStandardPath(path, issue.path), message: issue.message });
      }
      return undefined;
    }
    if (!isJsonValue(result.value)) {
      issues.push({ path, message: 'schema output must be JSON-serialisable' });
      return undefined;
    }
    if (jsonSize(result.value) > DEFAULT_JSON_MAX_BYTES * 4) {
      issues.push({ path, message: 'value is too large' });
      return undefined;
    }
    return result.value;
  }
  return validateBuiltIn(path, def, value, issues);
}

export interface ApplyPatchOptions {
  /** Path prefix for issue reporting, for example `preferences`. */
  path: string;
  /** Rejects changes to fields where `userEditable` resolves to false. */
  selfService: boolean;
  /** Default for `userEditable` when a definition does not set it. */
  editableByDefault: boolean;
  /** Allows keys without a definition (stored as JSON, size limited). */
  allowUnknown: boolean;
}

/**
 * Applies a patch to stored values. `null` removes the stored value (the default applies
 * again). Returns the new stored object or pushes issues.
 */
export async function applyFieldPatch(
  defs: FieldDefinitions,
  current: Record<string, unknown>,
  patch: unknown,
  options: ApplyPatchOptions,
  issues: ValidationIssue[],
): Promise<Record<string, unknown>> {
  const next: Record<string, unknown> = { ...current };
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    issues.push({ path: options.path, message: 'must be an object' });
    return next;
  }
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length > 200) {
    issues.push({ path: options.path, message: 'too many keys' });
    return next;
  }
  for (const [key, value] of entries) {
    const path = `${options.path}.${key}`;
    const def = Object.hasOwn(defs, key) ? defs[key] : undefined;
    if (!def) {
      if (!options.allowUnknown || !KEY_PATTERN.test(key)) {
        issues.push({ path, message: 'is not a defined field' });
        continue;
      }
      if (options.selfService) {
        issues.push({ path, message: 'is not a defined field' });
        continue;
      }
      if (value === null) {
        delete next[key];
      } else if (!isJsonValue(value) || jsonSize(value) > DEFAULT_JSON_MAX_BYTES) {
        issues.push({ path, message: 'must be a JSON value of at most 4096 bytes' });
      } else {
        next[key] = structuredClone(value);
      }
      continue;
    }
    if (options.selfService && !(def.userEditable ?? options.editableByDefault)) {
      issues.push({ path, message: 'cannot be changed by the user' });
      continue;
    }
    if (value === null || value === undefined) {
      if (def.required && def.default === undefined) {
        issues.push({ path, message: 'is required' });
      } else {
        delete next[key];
      }
      continue;
    }
    const out = await validateFieldValue(path, def, value, issues);
    if (out !== undefined) next[key] = out;
  }
  return next;
}

/** Stored values merged over definition defaults (only defined keys plus unknown extras). */
export function mergeWithDefaults(
  defs: FieldDefinitions,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (def.default !== undefined) out[key] = structuredClone(def.default);
  }
  for (const [key, value] of Object.entries(stored)) out[key] = structuredClone(value);
  return out;
}

/** Reports required fields without value or default. */
export function checkRequired(
  defs: FieldDefinitions,
  stored: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const [key, def] of Object.entries(defs)) {
    if (def.required && def.default === undefined && stored[key] === undefined) {
      issues.push({ path: `${path}.${key}`, message: 'is required' });
    }
  }
}

export { isJsonValue, jsonSize };
