import type { PathKey } from './issues.js';
import type {
  InferInput,
  InferOutput,
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from './standard-schema.js';

/** An issue produced by a custom rule. */
export interface RuleIssue {
  code: string;
  message: string;
  /** Path relative to the validated value. Default: the root. */
  path?: readonly PathKey[];
}

/** A rule that checks a predicate and reports one issue when it fails. */
export interface PredicateRule<T> {
  code: string;
  message: string | ((value: T) => string);
  path?: readonly PathKey[];
  /** Return true when the value is valid. May be async (for example a uniqueness lookup). */
  check: (value: T) => boolean | Promise<boolean>;
}

/** A rule function that returns zero or more issues. May be async. */
export type RuleFunction<T> = (
  value: T,
) => readonly RuleIssue[] | undefined | Promise<readonly RuleIssue[] | undefined>;

/** A custom validation rule. */
export type Rule<T> = PredicateRule<T> | RuleFunction<T>;

/** A Standard Schema returned by `refine`. */
export interface RefinedSchema<Input, Output> extends StandardSchemaV1<Input, Output> {
  /** The wrapped schema. */
  readonly base: StandardSchemaV1<Input, Output>;
}

type Issues = StandardSchemaV1.Issue & { code?: string };

function isPromise<T>(v: unknown): v is Promise<T> {
  return typeof v === 'object' && v !== null && typeof (v as Promise<T>).then === 'function';
}

function runRule<T>(rule: Rule<T>, value: T): Issues[] | Promise<Issues[]> {
  const toIssues = (list: readonly RuleIssue[] | undefined): Issues[] =>
    (list ?? []).map((i) => ({ message: i.message, code: i.code, path: [...(i.path ?? [])] }));
  if (typeof rule === 'function') {
    const out = rule(value);
    return isPromise<readonly RuleIssue[] | undefined>(out) ? out.then(toIssues) : toIssues(out);
  }
  const fail = (): Issues[] => [
    {
      code: rule.code,
      message: typeof rule.message === 'function' ? rule.message(value) : rule.message,
      path: [...(rule.path ?? [])],
    },
  ];
  const ok = rule.check(value);
  return isPromise<boolean>(ok) ? ok.then((v) => (v ? [] : fail())) : ok ? [] : fail();
}

/**
 * Wraps any Standard Schema with additional sync or async rules. Rules run only when the base
 * schema succeeds, receive the typed output, and all failing rules are reported together.
 * The result is itself a Standard Schema; a Standard JSON Schema converter on the base schema
 * (zod 4) is preserved so documentation generators keep working.
 */
export function refine<S extends StandardSchemaV1>(
  schema: S,
  rules: readonly Rule<InferOutput<S>>[],
): RefinedSchema<InferInput<S>, InferOutput<S>> {
  type Out = InferOutput<S>;
  const baseProps = schema['~standard'];
  const finish = (
    value: Out,
  ): StandardSchemaV1.Result<Out> | Promise<StandardSchemaV1.Result<Out>> => {
    const results = rules.map((r) => runRule(r, value));
    const done = (lists: Issues[][]): StandardSchemaV1.Result<Out> => {
      const issues = lists.flat();
      return issues.length > 0 ? { issues } : { value };
    };
    if (results.some(isPromise)) return Promise.all(results).then(done);
    return done(results as Issues[][]);
  };
  const validateFn = (
    input: unknown,
    options?: StandardSchemaV1.Options,
  ): StandardSchemaV1.Result<Out> | Promise<StandardSchemaV1.Result<Out>> => {
    const base = baseProps.validate(input, options);
    const next = (r: StandardSchemaV1.Result<unknown>) =>
      r.issues ? { issues: r.issues } : finish((r as StandardSchemaV1.SuccessResult<Out>).value);
    return isPromise<StandardSchemaV1.Result<unknown>>(base) ? base.then(next) : next(base);
  };
  const props: Record<string, unknown> = {
    version: 1,
    vendor: 'aspec',
    validate: validateFn,
  };
  if (baseProps.types !== undefined) props.types = baseProps.types;
  const jsonSchema = (baseProps as Partial<StandardJSONSchemaV1.Props>).jsonSchema;
  if (jsonSchema !== undefined) props.jsonSchema = jsonSchema;
  return {
    '~standard': props as unknown as StandardSchemaV1.Props<InferInput<S>, Out>,
    base: schema as unknown as StandardSchemaV1<InferInput<S>, Out>,
  };
}

/** Creates a predicate rule. */
export function rule<T>(
  code: string,
  message: string | ((value: T) => string),
  check: (value: T) => boolean | Promise<boolean>,
  options: { path?: readonly PathKey[] } = {},
): PredicateRule<T> {
  const r: PredicateRule<T> = { code, message, check };
  if (options.path !== undefined) r.path = options.path;
  return r;
}

type Keys<T> = Extract<keyof T, string>;

/** Reusable rule helpers. */
export const rules = {
  /** Two fields must be equal (for example password confirmation). Reports on `other`. */
  fieldsMatch<T extends object>(
    field: Keys<T>,
    other: Keys<T>,
    options: { message?: string; code?: string } = {},
  ): Rule<T> {
    return rule<T>(
      options.code ?? 'fields_mismatch',
      options.message ?? `Must match ${field}`,
      (v) => Object.is(v[field], v[other]),
      { path: [other] },
    );
  },

  /** All given fields are present together or all absent. */
  requiredTogether<T extends object>(
    fields: readonly Keys<T>[],
    options: { message?: string; code?: string } = {},
  ): Rule<T> {
    return (v) => {
      const present = fields.filter((f) => v[f] !== undefined && v[f] !== null);
      if (present.length === 0 || present.length === fields.length) return [];
      return fields
        .filter((f) => !present.includes(f))
        .map((f) => ({
          code: options.code ?? 'required_together',
          message: options.message ?? `Required when ${present.join(', ')} is set`,
          path: [f],
        }));
    };
  },

  /** At most one of the given fields may be set. */
  mutuallyExclusive<T extends object>(
    fields: readonly Keys<T>[],
    options: { message?: string; code?: string } = {},
  ): Rule<T> {
    return rule<T>(
      options.code ?? 'mutually_exclusive',
      options.message ?? `Only one of ${fields.join(', ')} may be set`,
      (v) => fields.filter((f) => v[f] !== undefined && v[f] !== null).length <= 1,
    );
  },

  /** At least one of the given fields must be set. */
  atLeastOne<T extends object>(
    fields: readonly Keys<T>[],
    options: { message?: string; code?: string } = {},
  ): Rule<T> {
    return rule<T>(
      options.code ?? 'at_least_one',
      options.message ?? `One of ${fields.join(', ')} is required`,
      (v) => fields.some((f) => v[f] !== undefined && v[f] !== null),
    );
  },

  /**
   * Items of an array (the value itself, or the array at `field`) must be unique by `key`.
   * Reports each duplicate at its index.
   */
  uniqueItems<T>(
    options: {
      field?: string;
      key?: (item: never) => unknown;
      message?: string;
      code?: string;
    } = {},
  ): Rule<T> {
    return (v) => {
      const list = options.field === undefined ? v : (v as Record<string, unknown>)[options.field];
      if (!Array.isArray(list)) return [];
      const seen = new Set<unknown>();
      const issues: RuleIssue[] = [];
      list.forEach((item, index) => {
        const k = options.key ? options.key(item as never) : item;
        const id = typeof k === 'object' && k !== null ? JSON.stringify(k) : k;
        if (seen.has(id)) {
          issues.push({
            code: options.code ?? 'duplicate_item',
            message: options.message ?? 'Duplicate item',
            path: options.field === undefined ? [index] : [options.field, index],
          });
        }
        seen.add(id);
      });
      return issues;
    };
  },

  /**
   * Async uniqueness check, for example against a database. `isUnique` receives the field value
   * and the whole object.
   */
  unique<T extends object, K extends Keys<T>>(
    field: K,
    isUnique: (value: T[K], whole: T) => boolean | Promise<boolean>,
    options: { message?: string; code?: string } = {},
  ): Rule<T> {
    return rule<T>(
      options.code ?? 'not_unique',
      options.message ?? 'Already in use',
      (v) => isUnique(v[field], v),
      { path: [field] },
    );
  },

  /** A date (or ISO string, or epoch ms) field must not be before another. Reports on `end`. */
  dateOrder<T extends object>(
    start: Keys<T>,
    end: Keys<T>,
    options: { message?: string; code?: string; allowEqual?: boolean } = {},
  ): Rule<T> {
    const time = (x: unknown): number | undefined => {
      if (x instanceof Date) return x.getTime();
      if (typeof x === 'string' || typeof x === 'number') {
        const t = new Date(x).getTime();
        return Number.isNaN(t) ? undefined : t;
      }
      return undefined;
    };
    return rule<T>(
      options.code ?? 'date_order',
      options.message ?? `Must be after ${start}`,
      (v) => {
        const a = time(v[start]);
        const b = time(v[end]);
        if (a === undefined || b === undefined) return true;
        return options.allowEqual === false ? b > a : b >= a;
      },
      { path: [end] },
    );
  },
} as const;
