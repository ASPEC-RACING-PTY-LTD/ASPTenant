import type { SqlDialect } from './ports.js';

export interface ScannedSql {
  /** SQL with `$n` placeholders rewritten to `?` (SQLite) or unchanged (PostgreSQL). */
  sql: string;
  /** Placeholder numbers in order of appearance, for example `[1, 2, 1]`. */
  placeholders: number[];
  /** Non-empty statements (comments and whitespace only fragments are dropped). */
  statements: string[];
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_CHAR.test(ch);
}

/**
 * Lexes SQL just enough to find statement separators and `$n` placeholders outside string
 * literals, quoted identifiers, comments and (PostgreSQL) dollar-quoted bodies. It is not a
 * parser: SQLite `CREATE TRIGGER ... BEGIN ...; END` bodies are reported as several
 * statements, which only matters for parameterised queries (never used for DDL).
 */
export function scanSql(
  input: string,
  dialect: SqlDialect,
  rewrite = dialect === 'sqlite',
): ScannedSql {
  const n = input.length;
  let out = '';
  const placeholders: number[] = [];
  const statements: string[] = [];
  let current = '';
  let hasContent = false;
  let i = 0;

  const emit = (text: string, content: boolean): void => {
    out += text;
    current += text;
    if (content) hasContent = true;
  };

  while (i < n) {
    const ch = input[i] as string;
    const next = input[i + 1];

    if (ch === '-' && next === '-') {
      const end = input.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      emit(input.slice(i, stop), false);
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && input[j] === '/' && input[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (input[j] === '*' && input[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      emit(input.slice(i, j), false);
      i = j;
      continue;
    }

    if (ch === "'") {
      const prev = input[i - 1];
      const escapes =
        dialect === 'postgres' && (prev === 'E' || prev === 'e') && !isIdentChar(input[i - 2]);
      let j = i + 1;
      while (j < n) {
        const c = input[j];
        if (escapes && c === '\\') {
          j += 2;
          continue;
        }
        if (c === "'") {
          if (input[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      emit(input.slice(i, j), true);
      i = j;
      continue;
    }

    if (ch === '"' || (dialect === 'sqlite' && (ch === '`' || ch === '['))) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n) {
        if (input[j] === close) {
          if (close !== ']' && input[j + 1] === close) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      emit(input.slice(i, j), true);
      i = j;
      continue;
    }

    if (ch === '$' && !isIdentChar(input[i - 1])) {
      if (next !== undefined && next >= '0' && next <= '9') {
        let j = i + 1;
        while (j < n && (input[j] as string) >= '0' && (input[j] as string) <= '9') j++;
        const index = Number(input.slice(i + 1, j));
        placeholders.push(index);
        emit(rewrite ? '?' : input.slice(i, j), true);
        i = j;
        continue;
      }
      if (dialect === 'postgres') {
        const tag = DOLLAR_TAG.exec(input.slice(i, i + 66));
        if (tag) {
          const delimiter = tag[0];
          const end = input.indexOf(delimiter, i + delimiter.length);
          const stop = end === -1 ? n : end + delimiter.length;
          emit(input.slice(i, stop), true);
          i = stop;
          continue;
        }
      }
    }

    if (ch === ';') {
      out += ch;
      if (hasContent) statements.push(current.trim());
      current = '';
      hasContent = false;
      i++;
      continue;
    }

    emit(ch, ch.trim() !== '');
    i++;
  }
  if (hasContent) statements.push(current.trim());
  return { sql: out, placeholders, statements };
}

/** Splits a script into individual statements (used for non-transactional migrations). */
export function splitStatements(sql: string, dialect: SqlDialect): string[] {
  return scanSql(sql, dialect, false).statements;
}

/** Number of non-empty statements in the SQL text. */
export function countStatements(sql: string, dialect: SqlDialect): number {
  return scanSql(sql, dialect, false).statements.length;
}
