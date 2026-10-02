import { readFileSync } from 'node:fs';
import type { ConfigIssue } from './errors.js';
import {
  parseBoolean,
  parseBytes,
  parseDurationMs,
  parseEmail,
  parseInteger,
  parseList,
  parseNumber,
  parsePort,
  parseUrl,
} from './parse.js';
import { Secret } from './secret.js';
import { isStandardSchema, type StandardSchemaV1 } from './standard-schema.js';

export type SourceMap = Readonly<Record<string, string | undefined>>;

export interface FieldMeta {
  name: string;
  description?: string;
  secret: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  example?: string;
  kind: string;
}

export type FieldResult<T> =
  | { ok: true; value: T; meta: FieldMeta }
  | { ok: false; issues: ConfigIssue[]; meta: FieldMeta };

type ParseFn<T> = (raw: string) => T | ConfigIssue;

interface FieldState<T> {
  name: string;
  kind: string;
  parse: ParseFn<T>;
  hasDefault: boolean;
  defaultValue?: T;
  optional: boolean;
  secret: boolean;
  description?: string;
  example?: string;
  fromFile: boolean;
}

function wrapSecret<T>(value: T, secret: boolean): T {
  if (!secret || value === undefined) return value;
  return new Secret(value) as T;
}

/** Typed environment variable builder with full inference through defineConfig. */
export class EnvField<T> {
  readonly #s: FieldState<T>;

  constructor(state: FieldState<T>) {
    this.#s = state;
  }

  description(text: string): EnvField<T> {
    return new EnvField({ ...this.#s, description: text });
  }

  example(text: string): EnvField<T> {
    return new EnvField({ ...this.#s, example: text });
  }

  default(value: T): EnvField<T> {
    return new EnvField({ ...this.#s, hasDefault: true, defaultValue: value });
  }

  optional(): EnvField<T | undefined> {
    return new EnvField({ ...this.#s, optional: true }) as EnvField<T | undefined>;
  }

  secret(): EnvField<Secret<T>> {
    return new EnvField({ ...this.#s, secret: true }) as unknown as EnvField<Secret<T>>;
  }

  noFile(): EnvField<T> {
    return new EnvField({ ...this.#s, fromFile: false });
  }

  meta(): FieldMeta {
    const m: FieldMeta = {
      name: this.#s.name,
      secret: this.#s.secret,
      hasDefault: this.#s.hasDefault,
      kind: this.#s.kind,
    };
    if (this.#s.description !== undefined) m.description = this.#s.description;
    if (this.#s.example !== undefined) m.example = this.#s.example;
    if (this.#s.hasDefault && !this.#s.secret) m.defaultValue = this.#s.defaultValue;
    return m;
  }

  resolve(source: SourceMap): FieldResult<T> {
    const meta = this.meta();
    const fileKey = `${this.#s.name}_FILE`;
    let raw = source[this.#s.name];
    if ((raw === undefined || raw === '') && this.#s.fromFile && source[fileKey]) {
      try {
        raw = readFileSync(source[fileKey] as string, 'utf8').replace(/\r?\n$/, '');
      } catch (err) {
        const issue: ConfigIssue = {
          path: this.#s.name,
          problem: 'file_unreadable',
          message: `could not read secret file from ${fileKey}`,
        };
        if (err instanceof Error) issue.hint = err.message;
        return { ok: false, meta, issues: [issue] };
      }
    }
    if (raw === undefined || raw === '') {
      if (this.#s.hasDefault) {
        return { ok: true, value: wrapSecret(this.#s.defaultValue as T, this.#s.secret), meta };
      }
      if (this.#s.optional) {
        return { ok: true, value: wrapSecret(undefined as T, this.#s.secret), meta };
      }
      return {
        ok: false,
        meta,
        issues: [
          {
            path: this.#s.name,
            problem: 'missing',
            message: `missing required environment variable ${this.#s.name}`,
            hint: this.#s.example ? `example: ${this.#s.example}` : `set ${this.#s.name}`,
          },
        ],
      };
    }
    const parsed = this.#s.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'problem' in parsed) {
      return { ok: false, meta, issues: [{ ...(parsed as ConfigIssue), path: this.#s.name }] };
    }
    return { ok: true, value: wrapSecret(parsed as T, this.#s.secret), meta };
  }
}

function checkName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid environment variable name: ${name}`);
  }
  return name;
}

function base<T>(name: string, kind: string, parse: ParseFn<T>): EnvField<T> {
  return new EnvField({
    name: checkName(name),
    kind,
    parse,
    hasDefault: false,
    optional: false,
    secret: false,
    fromFile: true,
  });
}

export interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

export const env = {
  string(name: string, options: StringOptions = {}): EnvField<string> {
    return base(name, 'string', (raw): string | ConfigIssue => {
      if (options.min !== undefined && raw.length < options.min) {
        return {
          path: name,
          problem: 'too_short',
          message: `must be at least ${options.min} characters`,
        };
      }
      if (options.max !== undefined && raw.length > options.max) {
        return {
          path: name,
          problem: 'too_long',
          message: `must be at most ${options.max} characters`,
        };
      }
      if (options.pattern && !options.pattern.test(raw)) {
        return { path: name, problem: 'pattern', message: `does not match ${options.pattern}` };
      }
      return raw;
    });
  },

  number(name: string): EnvField<number> {
    return base(name, 'number', parseNumber);
  },

  integer(name: string): EnvField<number> {
    return base(name, 'integer', parseInteger);
  },

  port(name: string): EnvField<number> {
    return base(name, 'port', parsePort);
  },

  boolean(name: string): EnvField<boolean> {
    return base(name, 'boolean', parseBoolean);
  },

  url(name: string, options: { protocols?: readonly string[] } = {}): EnvField<string> {
    return base(name, 'url', (raw) => parseUrl(raw, options.protocols));
  },

  email(name: string): EnvField<string> {
    return base(name, 'email', parseEmail);
  },

  enum<const V extends readonly string[]>(name: string, values: V): EnvField<V[number]> {
    const set = new Set<string>(values);
    return base(name, 'enum', (raw): V[number] | ConfigIssue => {
      if (!set.has(raw)) {
        return {
          path: name,
          problem: 'invalid_enum',
          message: `must be one of: ${values.join(', ')}`,
        };
      }
      return raw as V[number];
    });
  },

  list(name: string, options: { separator?: string } = {}): EnvField<string[]> {
    return base(name, 'list', (raw) => parseList(raw, options.separator ?? ','));
  },

  json<T = unknown>(name: string, schema?: StandardSchemaV1<unknown, T>): EnvField<T> {
    return base(name, 'json', (raw): T | ConfigIssue => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return { path: name, problem: 'invalid_json', message: 'expected JSON' };
      }
      if (!schema) return value as T;
      if (!isStandardSchema(schema)) {
        return {
          path: name,
          problem: 'invalid_schema',
          message: 'json schema must implement ~standard',
        };
      }
      const result = schema['~standard'].validate(value);
      if (result instanceof Promise) {
        return {
          path: name,
          problem: 'async_schema',
          message:
            'async Standard Schema validators are not supported in defineConfig; use loadConfig',
        };
      }
      if (result.issues) {
        return {
          path: name,
          problem: 'schema',
          message:
            result.issues.map((i) => i.message).join('; ') || 'JSON failed schema validation',
        };
      }
      return result.value;
    });
  },

  duration(name: string): EnvField<number> {
    return base(name, 'duration', parseDurationMs);
  },

  bytes(name: string): EnvField<number> {
    return base(name, 'bytes', parseBytes);
  },

  custom<T>(name: string, parse: ParseFn<T>): EnvField<T> {
    return base(name, 'custom', parse);
  },
};
