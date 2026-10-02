import { describe, expect, it } from 'vitest';
import { createRequestContext, getRequestId, runWithRequestContext } from '../src/context.js';
import { memoryDestination } from '../src/destinations.js';
import { createLogger } from '../src/logger.js';
import { serializeError } from '../src/serialize.js';

describe('logger', () => {
  it('writes JSON lines with levels, bindings and redaction', () => {
    const dest = memoryDestination();
    const log = createLogger({
      level: 'debug',
      bindings: { service: 'api' },
      destination: dest,
      redact: ['password', 'token'],
      context: false,
    });
    log.debug({ step: 1 }, 'dbg');
    log.info({ password: 'secret', nested: { token: 't' } }, 'login');
    log.warn('plain');
    expect(dest.lines.length).toBe(3);
    const infoLine = dest.lines[1];
    expect(infoLine).toBeDefined();
    const info = JSON.parse(infoLine as string);
    expect(info.level).toBe('info');
    expect(info.service).toBe('api');
    expect(info.password).toBe('[REDACTED]');
    expect(info.nested.token).toBe('[REDACTED]');
    expect(info.msg).toBe('login');
  });

  it('skips disabled levels cheaply and supports children', () => {
    const dest = memoryDestination();
    const log = createLogger({ level: 'warn', destination: dest, context: false });
    log.info('nope');
    log.child({ req: 1 }).error({ ok: true }, 'err');
    expect(dest.lines).toHaveLength(1);
    expect(dest.lines[0]).toBeDefined();
    expect(JSON.parse(dest.lines[0] as string).req).toBe(1);
  });

  it('serialises errors with causes', () => {
    const cause = new Error('root');
    const err = new Error('wrap', { cause });
    const ser = serializeError(err);
    expect(ser.message).toBe('wrap');
    expect(
      ser.cause && typeof ser.cause === 'object' && 'message' in ser.cause
        ? ser.cause.message
        : undefined,
    ).toBe('root');
  });

  it('enriches logs from request context across async boundaries', async () => {
    const dest = memoryDestination();
    const log = createLogger({ destination: dest, level: 'info' });
    const ctx = createRequestContext({ requestIdHeader: 'req-abc-12345678' });
    await runWithRequestContext(ctx, async () => {
      expect(getRequestId()).toBe('req-abc-12345678');
      await Promise.resolve();
      log.info('inside');
    });
    expect(dest.lines[0]).toBeDefined();
    const line = JSON.parse(dest.lines[0] as string);
    expect(line.requestId).toBe('req-abc-12345678');
  });
});
