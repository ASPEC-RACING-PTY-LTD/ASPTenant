import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  ConflictError,
  createCorrelationContext,
  createErrorHandler,
  createRedactor,
  ErrorsConfigError,
  InternalError,
  isDebugAllowed,
  isValidCorrelationId,
  NotFoundError,
  parseStack,
  RateLimitedError,
  redact,
  toDebugJSON,
  toErrorEnvelope,
  toProblemDetails,
  UnauthorizedError,
} from '../src/index.js';
import { memoryLogger } from './helpers/http.js';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redaction', () => {
  it('redacts sensitive keys at any depth, case and separator insensitive', () => {
    const out = redact({
      user: 'ada',
      Password: 'hunter2',
      nested: { 'x-api-key': 'k', accessToken: 't', list: [{ client_secret: 's' }] },
      headers: { Authorization: 'Bearer abc', Cookie: 'sid=1', 'set-cookie': ['a=b'] },
      auth: 'x',
      author: 'Grace',
    });
    expect(out).toEqual({
      user: 'ada',
      Password: '[REDACTED]',
      nested: {
        'x-api-key': '[REDACTED]',
        accessToken: '[REDACTED]',
        list: [{ client_secret: '[REDACTED]' }],
      },
      headers: { Authorization: '[REDACTED]', Cookie: '[REDACTED]', 'set-cookie': '[REDACTED]' },
      auth: '[REDACTED]',
      author: 'Grace',
    });
  });

  it('redacts secret values inside strings', () => {
    const r = createRedactor();
    expect(r.string(`token ${JWT} here`)).toBe('token [REDACTED] here');
    expect(r.string('Authorization: Bearer abcdef123456')).toBe('Authorization: Bearer [REDACTED]');
    expect(r.string('postgres://app:s3cr3t@db:5432/app')).toBe('postgres://[REDACTED]@db:5432/app');
    expect(r.string('/login?user=a&password=hunter2&x=1')).toBe(
      '/login?user=a&password=[REDACTED]&x=1',
    );
  });

  it('supports custom keys and handles cycles, depth, binary and errors', () => {
    const r = createRedactor({ keys: ['iban', /^x-internal-/i], maxDepth: 3 });
    const cyclic: Record<string, unknown> = { iban: 'DE00', 'X-Internal-Trace': 'abc' };
    cyclic.self = cyclic;
    cyclic.deep = { a: { b: { c: 1 } } };
    cyclic.bin = new Uint8Array(4);
    cyclic.err = new Error(`failed with ${JWT}`);
    const out = r(cyclic) as Record<string, unknown>;
    expect(out.iban).toBe('[REDACTED]');
    expect(out['X-Internal-Trace']).toBe('[REDACTED]');
    expect(out.self).toBe('[Circular]');
    expect(out.deep).toEqual({ a: { b: '[Truncated]' } });
    expect(out.bin).toBe('[Binary 4 bytes]');
    expect(out.err).toEqual({ name: 'Error', message: 'failed with [REDACTED]' });
  });
});

describe('problem details', () => {
  it('serialises exposed errors per RFC 9457', () => {
    const p = toProblemDetails(new NotFoundError('User 42 not found'), {
      typeBaseUri: 'https://errors.example.com/',
      instance: '/users/42',
      correlationId: 'req-1',
    });
    expect(p).toEqual({
      type: 'https://errors.example.com/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'User 42 not found',
      instance: '/users/42',
      code: 'NOT_FOUND',
      correlationId: 'req-1',
    });
    expect(toProblemDetails(new NotFoundError()).type).toBe('about:blank');
  });

  it('never exposes internal messages, stacks, causes or unexposed details in production', () => {
    const err = new InternalError('password=hunter2 failed at db.query', {
      details: { sql: 'SELECT * FROM users' },
      cause: new Error('inner'),
    });
    for (const debug of [false, true]) {
      const p = toProblemDetails(err, { debug, environment: 'production' });
      expect(p).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_ERROR',
      });
      const text = JSON.stringify(p);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('stack');
    }
  });

  it('includes redacted debug information only with debug outside production', () => {
    const err = new InternalError(`failed with ${JWT}`, {
      details: { password: 'hunter2', table: 'users' },
      cause: new Error('socket hang up'),
    });
    const p = toProblemDetails(err, { debug: true, environment: 'development' });
    expect(p.detail).toBe('failed with [REDACTED]');
    const debug = p.debug;
    expect(debug).toBeDefined();
    expect((debug!.cause as { message: string }).message).toBe('socket hang up');
    expect(debug!.details).toEqual({ password: '[REDACTED]', table: 'users' });
    expect(debug!.stack.length).toBeGreaterThan(0);
    expect(JSON.stringify(p)).not.toContain(JWT);
    expect(JSON.stringify(p)).not.toContain('hunter2');
    expect(isDebugAllowed(true, 'test')).toBe(true);
    expect(isDebugAllowed(true, 'production')).toBe(false);
    expect(isDebugAllowed(false, 'development')).toBe(false);
  });

  it('emits validation issues as the errors extension and redacts details', () => {
    const err = new BadRequestError('Invalid input', {
      details: {
        issues: [
          { path: ['password'], pointer: '/password', message: 'Too short', code: 'too_small' },
        ],
        hint: `token ${JWT}`,
      },
    });
    const p = toProblemDetails(err);
    expect(p.errors).toEqual([
      { path: ['password'], pointer: '/password', message: 'Too short', code: 'too_small' },
    ]);
    expect(p.details).toEqual({ hint: 'token [REDACTED]' });
  });

  it('supports the JSON envelope format', () => {
    const env = toErrorEnvelope(new ConflictError('Email taken', { details: { field: 'email' } }), {
      correlationId: 'c1',
    });
    expect(env).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Email taken',
        status: 409,
        correlationId: 'c1',
        details: { field: 'email' },
      },
    });
    expect(toErrorEnvelope(new InternalError('db password wrong')).error.message).toBe(
      'Internal Server Error',
    );
  });
});

describe('createErrorHandler', () => {
  it('builds responses with headers, correlation IDs and retry hints', () => {
    const handler = createErrorHandler({ typeBaseUri: 'https://errors.example.com' });
    const r = handler.handle(new RateLimitedError('Slow down', { retryAfter: 7 }), {
      method: 'GET',
      path: '/items',
      correlationId: 'abc-123',
    });
    expect(r.status).toBe(429);
    expect(r.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(r.headers['retry-after']).toBe('7');
    expect(r.headers['x-request-id']).toBe('abc-123');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      type: 'https://errors.example.com/rate-limited',
      instance: '/items',
      retryAfter: 7,
    });
    const u = handler.render(new UnauthorizedError('Login', { challenge: 'Bearer' }));
    expect(u.headers['www-authenticate']).toBe('Bearer');
  });

  it('uses the active correlation context and the envelope format', async () => {
    const handler = createErrorHandler({ format: 'envelope', includeInstance: false });
    const r = handler.correlation.run('ctx-id', () => handler.render(new NotFoundError()));
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        status: 404,
        correlationId: 'ctx-id',
      },
    });
    const res = handler.toResponse(new NotFoundError());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('applies the transform hook', () => {
    class OrmUniqueViolation extends Error {}
    const handler = createErrorHandler({
      transform: (err) =>
        err instanceof OrmUniqueViolation
          ? new ConflictError('Already exists', { cause: err })
          : err,
    });
    expect(handler.render(new OrmUniqueViolation('dup key users_email_key')).status).toBe(409);
  });

  it('validates options', () => {
    expect(() => createErrorHandler({ typeBaseUri: 'not a uri' })).toThrow(ErrorsConfigError);
    expect(() => createErrorHandler({ format: 'xml' as never })).toThrow(/format/);
    expect(() => createErrorHandler({ clientErrorLevel: 'loud' as never })).toThrow(
      /clientErrorLevel/,
    );
    expect(() => createErrorHandler({ dedupeClientErrors: { windowMs: 0 } })).toThrow(/windowMs/);
    expect(() => createErrorHandler({ logger: {} as never })).toThrow(/logger/);
    try {
      createErrorHandler({ typeBaseUri: 'https://x.test/?q=1' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'ERRORS_INVALID_OPTION', option: 'typeBaseUri' });
    }
  });
});

describe('logging integration', () => {
  it('logs 5xx at error with redacted debug information', () => {
    const { logger, entries } = memoryLogger();
    const handler = createErrorHandler({ logger });
    handler.handle(new InternalError(`db failed ${JWT}`, { cause: new Error('ECONNRESET') }), {
      method: 'POST',
      path: '/orders',
      correlationId: 'r1',
    });
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e?.level).toBe('error');
    expect(e?.obj).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      correlationId: 'r1',
      method: 'POST',
      path: '/orders',
    });
    const err = e?.obj.err as { stack: unknown[]; cause: { message: string } };
    expect(err.stack.length).toBeGreaterThan(0);
    expect(err.cause.message).toBe('ECONNRESET');
    expect(JSON.stringify(e)).not.toContain(JWT);
  });

  it('logs 4xx at the configured level, or not at all', () => {
    const a = memoryLogger();
    createErrorHandler({ logger: a.logger }).handle(new NotFoundError());
    expect(a.entries[0]?.level).toBe('info');
    const b = memoryLogger();
    createErrorHandler({ logger: b.logger, clientErrorLevel: 'warn' }).handle(new NotFoundError());
    expect(b.entries[0]?.level).toBe('warn');
    const c = memoryLogger();
    createErrorHandler({ logger: c.logger, clientErrorLevel: 'silent' }).handle(
      new NotFoundError(),
    );
    expect(c.entries).toHaveLength(0);
  });

  it('deduplicates noisy client errors within the window', () => {
    const { logger, entries } = memoryLogger();
    let now = 0;
    const handler = createErrorHandler({
      logger,
      dedupeClientErrors: { windowMs: 1000 },
      clock: { now: () => now },
    });
    const req = { method: 'GET', path: '/missing' };
    for (let i = 0; i < 5; i++) handler.handle(new NotFoundError(), req);
    handler.handle(new NotFoundError(), { method: 'GET', path: '/other' });
    expect(entries).toHaveLength(2);
    now = 1500;
    handler.handle(new NotFoundError(), req);
    expect(entries).toHaveLength(3);
    expect(entries[2]?.obj.suppressed).toBe(4);
    handler.handle(new InternalError(), req);
    handler.handle(new InternalError(), req);
    expect(entries.filter((e) => e.level === 'error')).toHaveLength(2);
  });

  it('never fails the response when the logger throws', () => {
    const throwing = {
      debug() {},
      info() {
        throw new Error('logger down');
      },
      warn() {},
      error() {},
    };
    const r = createErrorHandler({ logger: throwing }).handle(new NotFoundError());
    expect(r.status).toBe(404);
  });
});

describe('correlation', () => {
  it('accepts valid incoming IDs and generates otherwise', () => {
    let n = 0;
    const ctx = createCorrelationContext({ generateId: () => `gen-${++n}` });
    expect(ctx.resolve('abc-123')).toBe('abc-123');
    expect(ctx.resolve(['first', 'second'])).toBe('first');
    expect(ctx.resolve('bad id with spaces')).toBe('gen-1');
    expect(ctx.resolve('x'.repeat(129))).toBe('gen-2');
    expect(ctx.resolve('<script>')).toBe('gen-3');
    expect(ctx.resolve(undefined)).toBe('gen-4');
    const untrusted = createCorrelationContext({ trustIncoming: false, generateId: () => 'new' });
    expect(untrusted.resolve('abc')).toBe('new');
    expect(isValidCorrelationId('a.b:c_d-1')).toBe(true);
    expect(isValidCorrelationId('a\nb')).toBe(false);
    expect(() => createCorrelationContext({ header: 'bad header' })).toThrow(TypeError);
  });

  it('propagates through async work with AsyncLocalStorage', async () => {
    const ctx = createCorrelationContext();
    const seen = await ctx.run('outer', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return ctx.getId();
    });
    expect(seen).toBe('outer');
    expect(ctx.getId()).toBeUndefined();
  });
});

describe('toDebugJSON', () => {
  it('includes the cause chain, frames and aggregate members', () => {
    const root = new Error('root cause');
    const mid = new Error('middle', { cause: root });
    const agg = new AggregateError([new Error('a'), new Error('b')], 'many', { cause: mid });
    const info = toDebugJSON(agg);
    expect(info.name).toBe('AggregateError');
    expect((info.cause as { message: string }).message).toBe('middle');
    expect((info.cause as { cause: { message: string } }).cause.message).toBe('root cause');
    expect(info.errors?.map((e) => e.message)).toEqual(['a', 'b']);
    expect(info.stack[0]?.file).toBeTruthy();
  });

  it('stops at circular causes and non-error causes', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(() => JSON.stringify(toDebugJSON(a))).not.toThrow();
    expect(toDebugJSON(new Error('x', { cause: 'string cause' })).cause).toEqual({
      value: 'string cause',
    });
  });

  it('parses stack frames', () => {
    const frames = parseStack(
      'Error: x\n    at handler (/app/src/a.ts:10:5)\n    at /app/src/b.ts:3:1\n    at async Promise.all (index 0)',
    );
    expect(frames).toEqual([
      { function: 'handler', file: '/app/src/a.ts', line: 10, column: 5 },
      { file: '/app/src/b.ts', line: 3, column: 1 },
      { raw: 'at async Promise.all (index 0)' },
    ]);
  });
});
