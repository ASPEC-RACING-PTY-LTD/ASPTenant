import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  classifyError,
  InternalError,
  mapError,
  NotFoundError,
  RateLimitedError,
} from '../src/index.js';

class RbacDeniedError extends Error {
  override name = 'RbacDeniedError';
  readonly code = 'RBAC_PERMISSION_DENIED';
  readonly status = 403;
  readonly expose = true;
}

class StoreFailure extends Error {
  override name = 'StoreFailure';
  readonly code = 'AUTH_STORE_FAILURE';
  readonly status = 500;
  readonly expose = false;
  readonly details = { table: 'auth_sessions' };
}

describe('mapError', () => {
  it('maps AppError directly', () => {
    const m = mapError(new NotFoundError('User 42 not found'));
    expect(m).toMatchObject({
      rule: 'app-error',
      status: 404,
      code: 'NOT_FOUND',
      message: 'User 42 not found',
      title: 'Not Found',
      expose: true,
      category: 'not_found',
      operational: true,
    });
  });

  it('maps any ErrorLike from ASPEC modules by structure', () => {
    const m = mapError(new RbacDeniedError('Missing permission posts.delete'));
    expect(m).toMatchObject({
      rule: 'error-like',
      status: 403,
      code: 'RBAC_PERMISSION_DENIED',
      expose: true,
      message: 'Missing permission posts.delete',
      category: 'authorisation',
    });
    const hidden = mapError(new StoreFailure('connection string postgres://u:p@h/db'));
    expect(hidden.status).toBe(500);
    expect(hidden.code).toBe('AUTH_STORE_FAILURE');
    expect(hidden.expose).toBe(false);
    expect(hidden.message).toBe('Internal Server Error');
    expect(hidden.details).toBeUndefined();
  });

  it('maps validation errors (ErrorLike with details) and keeps details when exposed', () => {
    const err = Object.assign(new Error('Validation failed'), {
      name: 'ValidationError',
      code: 'VALIDATION_FAILED',
      status: 400,
      expose: true,
      details: { issues: [{ path: ['email'], pointer: '/email', message: 'Invalid', code: 'x' }] },
    });
    const m = mapError(err);
    expect(m.category).toBe('client');
    expect(m.details).toEqual(err.details);
    expect(mapError({ ...err, status: 422, name: 'ValidationError', message: 'x' }).category).toBe(
      'validation',
    );
  });

  it('maps JSON SyntaxError from body parsers to 400 INVALID_JSON', () => {
    const bodyParser = Object.assign(new SyntaxError('Unexpected token } in JSON at position 9'), {
      type: 'entity.parse.failed',
      status: 400,
      statusCode: 400,
      expose: true,
      body: '{"a": 1,}',
    });
    const m = mapError(bodyParser);
    expect(m).toMatchObject({ rule: 'json-syntax', status: 400, code: 'INVALID_JSON' });
    expect(m.message).toBe('Request body is not valid JSON');
    const fastifyStyle = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      statusCode: 400,
    });
    expect(mapError(fastifyStyle).code).toBe('INVALID_JSON');
    expect(mapError(new SyntaxError('in my own code')).status).toBe(500);
  });

  it('maps body-parser typed errors', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      statusCode: 413,
      expose: true,
      limit: 100,
      length: 200,
    });
    expect(mapError(tooLarge)).toMatchObject({
      rule: 'body-parser',
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      expose: true,
    });
    const charset = Object.assign(new Error('unsupported charset "UTF-7"'), {
      type: 'charset.unsupported',
      status: 415,
    });
    expect(mapError(charset).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('maps Fastify statusCode errors without exposing library messages', () => {
    const err = Object.assign(new Error("'/%zz' is not a valid url component"), {
      code: 'FST_ERR_BAD_URL',
      statusCode: 400,
    });
    const m = mapError(err);
    expect(m).toMatchObject({ rule: 'status-property', status: 400, code: 'BAD_REQUEST' });
    expect(m.expose).toBe(false);
    expect(m.message).toBe('Bad Request');
  });

  it('maps Fastify content parser errors with safe messages', () => {
    const invalid = Object.assign(
      new Error("Body is not valid JSON but content-type is set to 'application/json'"),
      {
        code: 'FST_ERR_CTP_INVALID_JSON_BODY',
        statusCode: 400,
      },
    );
    expect(mapError(invalid)).toMatchObject({
      status: 400,
      code: 'INVALID_JSON',
      message: 'Request body is not valid JSON',
    });
    const empty = Object.assign(new Error('x'), {
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
      statusCode: 400,
    });
    expect(mapError(empty)).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Request body is empty',
    });
    const large = Object.assign(new Error('x'), {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      statusCode: 413,
    });
    expect(mapError(large)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('maps Fastify schema validation errors', () => {
    const err = Object.assign(new Error("body must have required property 'name'"), {
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
      validation: [
        { instancePath: '', keyword: 'required', message: "must have required property 'name'" },
      ],
    });
    const m = mapError(err);
    expect(m.code).toBe('VALIDATION_FAILED');
    expect(m.details).toEqual({
      issues: [{ path: '', code: 'required', message: "must have required property 'name'" }],
    });
  });

  it('maps AbortError and TimeoutError to 504 TIMEOUT', () => {
    const abort = AbortSignal.abort().reason;
    expect(mapError(abort)).toMatchObject({ rule: 'timeout', status: 504, code: 'TIMEOUT' });
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(mapError(timeout).category).toBe('timeout');
    expect(mapError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).status).toBe(504);
  });

  it('maps network errors to 502 without exposing hostnames', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
    });
    const m = mapError(err);
    expect(m).toMatchObject({ status: 502, code: 'DEPENDENCY_FAILURE', category: 'dependency' });
    expect(m.message).not.toContain('10.0.0.5');
  });

  it('maps retryAfter and retryAfterMs', () => {
    expect(mapError(new RateLimitedError('x', { retryAfter: 12 })).retryAfter).toBe(12);
    const limiter = {
      name: 'RateLimitError',
      message: 'x',
      code: 'RATE_LIMIT_EXCEEDED',
      status: 429,
      expose: true,
      retryAfterMs: 1500,
    };
    expect(mapError(limiter).retryAfter).toBe(2);
  });

  it('maps everything else to a generic 500', () => {
    for (const value of [new TypeError('x is undefined'), 'boom', null, undefined, 42, { a: 1 }]) {
      const m = mapError(value);
      expect(m.status).toBe(500);
      expect(m.code).toBe('INTERNAL_ERROR');
      expect(m.expose).toBe(false);
      expect(m.message).toBe('Internal Server Error');
    }
    expect(mapError(new TypeError('x')).rule).toBe('programmer');
    expect(mapError('boom').internalMessage).toBe('boom');
  });

  it('ignores invalid status hints', () => {
    expect(mapError({ name: 'X', message: 'y', status: 200 }).status).toBe(500);
    expect(mapError({ name: 'X', message: 'y', status: '404' }).status).toBe(500);
  });
});

describe('classifyError', () => {
  it.each([
    [new BadRequestError(), 'client', true],
    [{ name: 'E', message: 'm', status: 401 }, 'authentication', true],
    [{ name: 'E', message: 'm', status: 403 }, 'authorisation', true],
    [{ name: 'E', message: 'm', status: 404 }, 'not_found', true],
    [{ name: 'E', message: 'm', status: 409 }, 'conflict', true],
    [{ name: 'E', message: 'm', status: 422 }, 'validation', true],
    [{ name: 'E', message: 'm', status: 429 }, 'rate_limit', true],
    [Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'dependency', true],
    [AbortSignal.abort().reason, 'timeout', true],
    [new InternalError(), 'internal', false],
    [new ReferenceError('y is not defined'), 'internal', false],
  ])('classifies %o', (err, category, operational) => {
    const c = classifyError(err);
    expect(c.category).toBe(category);
    expect(c.operational).toBe(operational);
  });
});
