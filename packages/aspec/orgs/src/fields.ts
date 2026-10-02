import { OrgsError, type ValidationIssue, validationError } from './errors.js';

interface FieldBase {
  description?: string;
  required?: boolean;
}

export interface StringField extends FieldBase {
  type: 'string';
  default?: string;
  minLength?: number;
  maxLength?: number;
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

export interface JsonField extends FieldBase {
  type: 'json';
  default?: unknown;
  maxBytes?: number;
}

export type FieldDefinition = StringField | NumberField | BooleanField | JsonField;
export type FieldDefinitions = Readonly<Record<string, FieldDefinition>>;

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function jsonSize(value: unknown): number {
  const s = JSON.stringify(value);
  return s === undefined ? 0 : Buffer.byteLength(s, 'utf8');
}

export function assertFieldDefinitions(option: string, defs: FieldDefinitions | undefined): void {
  if (defs === undefined) return;
  if (typeof defs !== 'object' || defs === null) {
    throw new OrgsError('ORGS_CONFIG_INVALID', `${option} must be an object`);
  }
  for (const [key, def] of Object.entries(defs)) {
    if (!KEY_PATTERN.test(key)) {
      throw new OrgsError('ORGS_CONFIG_INVALID', `${option}.${key}: invalid key`);
    }
    if (!def || typeof def !== 'object' || !('type' in def)) {
      throw new OrgsError('ORGS_CONFIG_INVALID', `${option}.${key}: missing type`);
    }
  }
}

async function validateOne(path: string, def: FieldDefinition, value: unknown): Promise<unknown> {
  if (value === undefined || value === null) {
    if (def.required && def.default === undefined) {
      throw validationError([{ path, message: 'is required' }]);
    }
    return def.default;
  }
  switch (def.type) {
    case 'string': {
      if (typeof value !== 'string') throw validationError([{ path, message: 'must be a string' }]);
      if (def.enum && !def.enum.includes(value)) {
        throw validationError([{ path, message: `must be one of ${def.enum.join(', ')}` }]);
      }
      if (def.minLength !== undefined && value.length < def.minLength) {
        throw validationError([{ path, message: `minLength ${def.minLength}` }]);
      }
      const max = def.maxLength ?? 2000;
      if (value.length > max) throw validationError([{ path, message: `maxLength ${max}` }]);
      if (def.pattern && !new RegExp(def.pattern).test(value)) {
        throw validationError([{ path, message: 'does not match pattern' }]);
      }
      return value;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw validationError([{ path, message: 'must be a number' }]);
      }
      if (def.type === 'integer' && !Number.isInteger(value)) {
        throw validationError([{ path, message: 'must be an integer' }]);
      }
      if (def.min !== undefined && value < def.min) {
        throw validationError([{ path, message: `min ${def.min}` }]);
      }
      if (def.max !== undefined && value > def.max) {
        throw validationError([{ path, message: `max ${def.max}` }]);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean')
        throw validationError([{ path, message: 'must be a boolean' }]);
      return value;
    }
    case 'json': {
      const max = def.maxBytes ?? 4096;
      if (jsonSize(value) > max) throw validationError([{ path, message: `max ${max} bytes` }]);
      return value;
    }
    default:
      throw validationError([{ path, message: 'unknown field type' }]);
  }
}

export async function applyFieldPatch(
  defs: FieldDefinitions,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const issues: ValidationIssue[] = [];
  const next = { ...current };
  for (const key of Object.keys(patch)) {
    const def = defs[key];
    if (!def) {
      issues.push({ path: key, message: 'unknown field' });
      continue;
    }
    try {
      const value = await validateOne(key, def, patch[key]);
      if (value === undefined) delete next[key];
      else next[key] = value;
    } catch (err) {
      if (err instanceof OrgsError && err.code === 'ORGS_VALIDATION_FAILED') {
        const detail = err.details as { issues?: ValidationIssue[] } | undefined;
        issues.push(...(detail?.issues ?? [{ path: key, message: err.message }]));
      } else throw err;
    }
  }
  if (issues.length) throw validationError(issues);
  return next;
}

export function mergeWithDefaults(
  defs: FieldDefinitions,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (Object.hasOwn(stored, key)) out[key] = stored[key];
    else if (def.default !== undefined) out[key] = def.default;
  }
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}
