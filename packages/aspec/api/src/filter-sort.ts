import { BadRequestError } from '@aspec/errors';
import type { SqlDialect } from './ports.js';

export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'startsWith',
  'isNull',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterClause {
  field: string;
  op: FilterOperator;
  value: unknown;
}

export interface SortClause {
  field: string;
  direction: 'asc' | 'desc';
}

export interface FilterSortAst {
  filters: FilterClause[];
  sort: SortClause[];
}

export interface FieldSpec {
  /** Allowed filter operators. Default: all. */
  operators?: readonly FilterOperator[];
  /** SQL column identifier (validated). Required for SQL builder. */
  column?: string;
  /** Coerce query string values. Default: identity (strings). */
  coerce?: (raw: string) => unknown;
  /** When true, field may appear in sort. Default true if listed. */
  sortable?: boolean;
  /** When true, field may appear in filters. Default true if listed. */
  filterable?: boolean;
}

export type FieldWhitelist = Readonly<Record<string, FieldSpec>>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertField(name: string, whitelist: FieldWhitelist, kind: 'filter' | 'sort'): FieldSpec {
  if (!Object.hasOwn(whitelist, name)) {
    throw new BadRequestError(`Unknown ${kind} field: ${name}`, {
      code: 'API_UNKNOWN_FIELD',
      details: { field: name, kind },
    });
  }
  const spec = whitelist[name]!;
  if (kind === 'filter' && spec.filterable === false) {
    throw new BadRequestError(`Field is not filterable: ${name}`, {
      code: 'API_UNKNOWN_FIELD',
      details: { field: name, kind },
    });
  }
  if (kind === 'sort' && spec.sortable === false) {
    throw new BadRequestError(`Field is not sortable: ${name}`, {
      code: 'API_UNKNOWN_FIELD',
      details: { field: name, kind },
    });
  }
  return spec;
}

function parseOp(raw: string | undefined): FilterOperator {
  const op = (raw ?? 'eq') as FilterOperator;
  if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
    throw new BadRequestError(`Unknown filter operator: ${raw}`, {
      code: 'API_UNKNOWN_OPERATOR',
      details: { operator: raw },
    });
  }
  return op;
}

function coerceValue(spec: FieldSpec, raw: string, op: FilterOperator): unknown {
  if (op === 'isNull') {
    if (raw === '' || raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new BadRequestError('isNull expects true or false', { code: 'API_INVALID_FILTER' });
  }
  if (op === 'in') {
    return raw.split(',').map((part) => (spec.coerce ? spec.coerce(part) : part));
  }
  return spec.coerce ? spec.coerce(raw) : raw;
}

/**
 * Parses `filter[status]=active&filter[createdAt][gte]=...&sort=-createdAt,name`
 * into a typed AST, rejecting fields/operators outside the whitelist.
 */
export function parseFilterSort(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
  whitelist: FieldWhitelist,
): FilterSortAst {
  let params: URLSearchParams;
  if (input instanceof URLSearchParams) {
    params = input;
  } else {
    params = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) params.append(k, item);
      else params.set(k, v);
    }
  }

  const filters: FilterClause[] = [];
  for (const [key, raw] of params.entries()) {
    const simple = /^filter\[([^\]]+)\]$/.exec(key);
    const nested = /^filter\[([^\]]+)\]\[([^\]]+)\]$/.exec(key);
    if (!simple && !nested) continue;
    const field = (simple?.[1] ?? nested?.[1])!;
    const op = parseOp(nested?.[2]);
    const spec = assertField(field, whitelist, 'filter');
    const allowed = spec.operators ?? FILTER_OPERATORS;
    if (!allowed.includes(op)) {
      throw new BadRequestError(`Operator ${op} is not allowed on ${field}`, {
        code: 'API_UNKNOWN_OPERATOR',
        details: { field, operator: op },
      });
    }
    filters.push({ field, op, value: coerceValue(spec, raw, op) });
  }

  const sort: SortClause[] = [];
  const sortRaw = params.get('sort');
  if (sortRaw !== null && sortRaw !== '') {
    for (const part of sortRaw.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const desc = trimmed.startsWith('-');
      const field = desc ? trimmed.slice(1) : trimmed;
      assertField(field, whitelist, 'sort');
      sort.push({ field, direction: desc ? 'desc' : 'asc' });
    }
  }

  return { filters, sort };
}

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * Builds a parameterised WHERE/ORDER BY fragment from a filter/sort AST.
 * Column names come only from the whitelist (`column` or the field key when it is a safe identifier).
 */
export function toSql(
  ast: FilterSortAst,
  whitelist: FieldWhitelist,
  dialect: SqlDialect,
  options: { tableAlias?: string; startIndex?: number } = {},
): SqlFragment {
  const alias = options.tableAlias;
  let index = options.startIndex ?? 1;
  const params: unknown[] = [];
  const where: string[] = [];

  const col = (field: string): string => {
    const spec = whitelist[field]!;
    const name = spec.column ?? field;
    if (!IDENT.test(name)) {
      throw new BadRequestError(`Invalid column mapping for ${field}`, {
        code: 'API_INVALID_COLUMN',
        details: { field },
      });
    }
    return alias ? `${alias}.${name}` : name;
  };

  const ph = (): string => `$${index++}`;

  for (const clause of ast.filters) {
    const c = col(clause.field);
    switch (clause.op) {
      case 'eq':
        where.push(`${c} = ${ph()}`);
        params.push(clause.value);
        break;
      case 'ne':
        where.push(`${c} <> ${ph()}`);
        params.push(clause.value);
        break;
      case 'gt':
        where.push(`${c} > ${ph()}`);
        params.push(clause.value);
        break;
      case 'gte':
        where.push(`${c} >= ${ph()}`);
        params.push(clause.value);
        break;
      case 'lt':
        where.push(`${c} < ${ph()}`);
        params.push(clause.value);
        break;
      case 'lte':
        where.push(`${c} <= ${ph()}`);
        params.push(clause.value);
        break;
      case 'in': {
        const list = clause.value as unknown[];
        if (list.length === 0) {
          where.push(dialect === 'postgres' ? 'FALSE' : '0');
          break;
        }
        const placeholders = list.map(() => ph());
        where.push(`${c} IN (${placeholders.join(', ')})`);
        params.push(...list);
        break;
      }
      case 'contains':
        where.push(`${c} LIKE ${ph()}`);
        params.push(`%${String(clause.value)}%`);
        break;
      case 'startsWith':
        where.push(`${c} LIKE ${ph()}`);
        params.push(`${String(clause.value)}%`);
        break;
      case 'isNull':
        where.push(clause.value ? `${c} IS NULL` : `${c} IS NOT NULL`);
        break;
    }
  }

  const order = ast.sort.map((s) => `${col(s.field)} ${s.direction.toUpperCase()}`);
  const parts: string[] = [];
  if (where.length > 0) parts.push(`WHERE ${where.join(' AND ')}`);
  if (order.length > 0) parts.push(`ORDER BY ${order.join(', ')}`);
  return { sql: parts.join(' '), params };
}

/** Applies filter/sort AST to an in-memory array (stable sort). */
export function applyInMemory<T extends Record<string, unknown>>(
  rows: readonly T[],
  ast: FilterSortAst,
): T[] {
  const filtered = rows.filter((row) =>
    ast.filters.every((clause) => matchClause(row[clause.field], clause)),
  );
  if (ast.sort.length === 0) return [...filtered];
  return [...filtered].sort((a, b) => {
    for (const s of ast.sort) {
      const av = a[s.field];
      const bv = b[s.field];
      if (av === bv) continue;
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return s.direction === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}

function matchClause(value: unknown, clause: FilterClause): boolean {
  switch (clause.op) {
    case 'eq':
      return Object.is(value, clause.value) || String(value) === String(clause.value);
    case 'ne':
      return !(Object.is(value, clause.value) || String(value) === String(clause.value));
    case 'gt':
      return (value as never) > (clause.value as never);
    case 'gte':
      return (value as never) >= (clause.value as never);
    case 'lt':
      return (value as never) < (clause.value as never);
    case 'lte':
      return (value as never) <= (clause.value as never);
    case 'in':
      return (clause.value as unknown[]).includes(value);
    case 'contains':
      return String(value ?? '').includes(String(clause.value));
    case 'startsWith':
      return String(value ?? '').startsWith(String(clause.value));
    case 'isNull':
      return clause.value
        ? value === null || value === undefined
        : value !== null && value !== undefined;
  }
}
