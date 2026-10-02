import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { createSqliteClient } from '../src/drivers/better-sqlite3.js';
import type { QueryEvent, SpanLike } from '../src/instrumentation.js';
import { redactSql } from '../src/instrumentation.js';
import { recordingLogger } from './helpers.js';

describe('instrumentation', () => {
  let db: Database;

  beforeEach(async () => {
    db = createSqliteClient({ filename: ':memory:' });
    await db.connect();
  });

  afterEach(async () => {
    await db.close();
  });

  it('redacts password literals in SQL', () => {
    expect(redactSql(`ALTER ROLE u PASSWORD 's3cret'`)).toContain("PASSWORD '***'");
  });

  it('redacts parameters by default and records slow queries', async () => {
    const events: QueryEvent[] = [];
    const { entries, logger } = recordingLogger();
    await db.close();
    db = createSqliteClient({
      filename: ':memory:',
      onQuery: (e) => events.push(e),
      logger,
      slowQueryThresholdMs: 0,
    });
    await db.connect();
    await db.query('SELECT $1 AS v', ['secret-value']);
    expect(events.some((e) => e.params.includes('[REDACTED]'))).toBe(true);
    expect(events.every((e) => !JSON.stringify(e.params).includes('secret-value'))).toBe(true);
    expect(entries.some((e) => e.level === 'warn' && e.msg === 'slow query')).toBe(true);
  });

  it('creates OpenTelemetry spans when a tracer is provided', async () => {
    const spans: Array<{ name: string; attrs: Record<string, unknown>; status?: unknown }> = [];
    const tracer = {
      startSpan(
        name: string,
        options?: { attributes?: Record<string, string | number | boolean> },
      ) {
        const attrs = { ...(options?.attributes ?? {}) };
        const span: SpanLike = {
          setAttribute(key, value) {
            attrs[key] = value;
          },
          setStatus(status) {
            const current = spans[spans.length - 1];
            if (current) current.status = status;
          },
          recordException() {},
          end() {},
        };
        spans.push({ name, attrs });
        return span;
      },
    };
    await db.close();
    db = createSqliteClient({ filename: ':memory:', tracer });
    await db.connect();
    await db.query('SELECT 1');
    expect(spans.some((s) => s.name.includes('SELECT') || s.attrs['db.system'] === 'sqlite')).toBe(
      true,
    );
  });
});
