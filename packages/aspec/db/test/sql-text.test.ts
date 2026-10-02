import { describe, expect, it } from 'vitest';
import { prepareSqlite } from '../src/drivers/sqlite-common.js';
import { countStatements, scanSql, splitStatements } from '../src/sql-text.js';

describe('scanSql', () => {
  it('rewrites $n to ? for SQLite and records the order', () => {
    const scanned = scanSql('SELECT * FROM t WHERE a = $1 AND b = $2 OR c = $1', 'sqlite');
    expect(scanned.sql).toBe('SELECT * FROM t WHERE a = ? AND b = ? OR c = ?');
    expect(scanned.placeholders).toEqual([1, 2, 1]);
  });

  it('keeps PostgreSQL SQL unchanged', () => {
    const scanned = scanSql('SELECT $1, $2', 'postgres');
    expect(scanned.sql).toBe('SELECT $1, $2');
    expect(scanned.placeholders).toEqual([1, 2]);
  });

  it('ignores placeholders in strings, quoted identifiers and comments', () => {
    const sql = `SELECT '$1', "col$2", [x$3], \`y$4\`, $5 -- $6\n/* $7 */`;
    expect(scanSql(sql, 'sqlite').placeholders).toEqual([5]);
  });

  it('handles escaped quotes', () => {
    expect(scanSql("SELECT 'it''s $1', $2", 'sqlite').placeholders).toEqual([2]);
    expect(scanSql("SELECT E'a\\'b $1', $2", 'postgres').placeholders).toEqual([2]);
  });

  it('does not treat identifier characters followed by $ as placeholders', () => {
    expect(scanSql('SELECT a$1 FROM t', 'postgres').placeholders).toEqual([]);
  });

  it('understands PostgreSQL dollar-quoted bodies and nested comments', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT $1; $body$ LANGUAGE sql;
      /* outer /* inner; */ still comment; */
      SELECT $$ ; $$;`;
    expect(splitStatements(sql, 'postgres')).toHaveLength(2);
    expect(scanSql(sql, 'postgres').placeholders).toEqual([]);
  });

  it('counts statements, ignoring empty fragments and trailing semicolons', () => {
    expect(countStatements('SELECT 1;', 'sqlite')).toBe(1);
    expect(countStatements('SELECT 1;; -- trailing\n', 'sqlite')).toBe(1);
    expect(countStatements("SELECT ';'; SELECT 2", 'sqlite')).toBe(2);
    expect(countStatements('-- only a comment', 'postgres')).toBe(0);
  });
});

describe('prepareSqlite', () => {
  it('expands reused placeholders into positional arguments', () => {
    expect(prepareSqlite('SELECT $2, $1, $2', ['a', 'b'])).toEqual({
      mode: 'statement',
      sql: 'SELECT ?, ?, ?',
      args: ['b', 'a', 'b'],
    });
  });

  it('normalises parameters', () => {
    const date = new Date(1_700_000_000_000);
    const prepared = prepareSqlite('SELECT $1, $2, $3, $4, $5, $6, $7', [
      true,
      false,
      date,
      undefined,
      { a: 1 },
      [1, 2],
      10n,
    ]);
    expect(prepared).toMatchObject({
      args: [1, 0, 1_700_000_000_000, null, '{"a":1}', '[1,2]', 10n],
    });
  });

  it('routes parameterless scripts to exec and rejects parameterised ones', () => {
    expect(prepareSqlite('SELECT 1; SELECT 2', [])).toEqual({
      mode: 'exec',
      sql: 'SELECT 1; SELECT 2',
    });
    expect(() => prepareSqlite('SELECT $1; SELECT 2', [1])).toThrow(/exactly one statement/);
  });

  it('rejects missing, extra and zero-numbered parameters', () => {
    expect(() => prepareSqlite('SELECT $1, $2', [1])).toThrow(/2 parameter/);
    expect(() => prepareSqlite('SELECT $1', [1, 2])).toThrow(/1 parameter/);
    expect(() => prepareSqlite('SELECT $0', [1])).toThrow(/start at \$1/);
  });
});
