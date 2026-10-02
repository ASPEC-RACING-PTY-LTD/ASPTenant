import { describe, expect, it } from 'vitest';
import {
  AppError,
  BadRequestError,
  ConflictError,
  DependencyFailureError,
  defineError,
  ForbiddenError,
  GoneError,
  hasCode,
  InternalError,
  isAppError,
  isErrorLike,
  NotFoundError,
  NotImplementedError,
  PayloadTooLargeError,
  RateLimitedError,
  ServiceUnavailableError,
  TimeoutError,
  UnauthorizedError,
  UnprocessableError,
} from '../src/index.js';

describe('typed errors', () => {
  const cases = [
    [BadRequestError, 'BadRequestError', 'BAD_REQUEST', 400, 'client', true, true],
    [UnauthorizedError, 'UnauthorizedError', 'UNAUTHORIZED', 401, 'authentication', true, true],
    [ForbiddenError, 'ForbiddenError', 'FORBIDDEN', 403, 'authorisation', true, true],
    [NotFoundError, 'NotFoundError', 'NOT_FOUND', 404, 'not_found', true, true],
    [ConflictError, 'ConflictError', 'CONFLICT', 409, 'conflict', true, true],
    [GoneError, 'GoneError', 'GONE', 410, 'not_found', true, true],
    [PayloadTooLargeError, 'PayloadTooLargeError', 'PAYLOAD_TOO_LARGE', 413, 'client', true, true],
    [
      UnprocessableError,
      'UnprocessableError',
      'UNPROCESSABLE_ENTITY',
      422,
      'validation',
      true,
      true,
    ],
    [RateLimitedError, 'RateLimitedError', 'RATE_LIMITED', 429, 'rate_limit', true, true],
    [InternalError, 'InternalError', 'INTERNAL_ERROR', 500, 'internal', false, false],
    [NotImplementedError, 'NotImplementedError', 'NOT_IMPLEMENTED', 501, 'internal', true, true],
    [
      ServiceUnavailableError,
      'ServiceUnavailableError',
      'SERVICE_UNAVAILABLE',
      503,
      'dependency',
      true,
      true,
    ],
    [TimeoutError, 'TimeoutError', 'TIMEOUT', 504, 'timeout', true, true],
    [
      DependencyFailureError,
      'DependencyFailureError',
      'DEPENDENCY_FAILURE',
      502,
      'dependency',
      false,
      true,
    ],
  ] as const;

  it.each(cases)(
    '%o has the documented defaults',
    (Ctor, name, code, status, category, expose, operational) => {
      const err = new Ctor();
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.category).toBe(category);
      expect(err.expose).toBe(expose);
      expect(err.operational).toBe(operational);
      expect(err.message.length).toBeGreaterThan(0);
      expect(isAppError(err)).toBe(true);
      expect(isErrorLike(err)).toBe(true);
    },
  );

  it('accepts code overrides, details, cause and correlation IDs', () => {
    const cause = new Error('db down');
    const err = new ConflictError('Email taken', {
      code: 'USER_EMAIL_TAKEN',
      details: { field: 'email' },
      cause,
      correlationId: 'req-1',
    });
    expect(err.code).toBe('USER_EMAIL_TAKEN');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ field: 'email' });
    expect(err.cause).toBe(cause);
    expect(err.correlationId).toBe('req-1');
  });

  it('carries retryAfter and challenge headers', () => {
    expect(new RateLimitedError('Slow down', { retryAfter: 30 }).retryAfter).toBe(30);
    const u = new UnauthorizedError('Login required', { challenge: 'Bearer realm="api"' });
    expect(u.headers['www-authenticate']).toBe('Bearer realm="api"');
  });

  it('rejects invalid codes, statuses and retryAfter', () => {
    expect(() => new AppError('x', { code: 'not-snake' })).toThrow(TypeError);
    expect(() => new AppError('x', { status: 200 })).toThrow(TypeError);
    expect(() => new AppError('x', { status: 600 })).toThrow(TypeError);
    expect(() => new AppError('x', { status: 404.5 })).toThrow(TypeError);
    expect(() => new RateLimitedError('x', { retryAfter: -1 })).toThrow(TypeError);
  });

  it('toJSON never includes stack, cause or unexposed data', () => {
    const internal = new InternalError('secret db password in message', {
      details: { query: 'SELECT 1' },
      cause: new Error('inner'),
    });
    const json = internal.toJSON();
    expect(json).toEqual({ name: 'InternalError', code: 'INTERNAL_ERROR', status: 500 });
    const exposed = new BadRequestError('Bad input', { details: { field: 'x' } }).toJSON();
    expect(exposed).toEqual({
      name: 'BadRequestError',
      code: 'BAD_REQUEST',
      status: 400,
      message: 'Bad input',
      details: { field: 'x' },
    });
    expect(JSON.stringify(exposed)).not.toContain('stack');
  });
});

describe('defineError', () => {
  const EmailTaken = defineError('USER_EMAIL_TAKEN', {
    status: 409,
    message: 'Email already in use',
  });
  const PaymentGatewayDown = defineError('PAYMENT_GATEWAY_DOWN', {
    status: 503,
    category: 'dependency',
    title: 'Payments unavailable',
  });

  it('creates classes with instanceof support and static metadata', () => {
    const err = new EmailTaken();
    expect(err).toBeInstanceOf(EmailTaken);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('UserEmailTakenError');
    expect(EmailTaken.name).toBe('UserEmailTakenError');
    expect(EmailTaken.code).toBe('USER_EMAIL_TAKEN');
    expect(EmailTaken.status).toBe(409);
    expect(err.message).toBe('Email already in use');
    expect(err.expose).toBe(true);
    expect(err.category).toBe('conflict');
    expect(new PaymentGatewayDown().expose).toBe(false);
    expect(new PaymentGatewayDown().title).toBe('Payments unavailable');
    expect(new PaymentGatewayDown().category).toBe('dependency');
  });

  it('provides a structural type guard', () => {
    const err: unknown = new EmailTaken('custom', { details: { email: 'a@b.c' } });
    expect(EmailTaken.is(err)).toBe(true);
    expect(PaymentGatewayDown.is(err)).toBe(false);
    if (EmailTaken.is(err)) {
      const code: 'USER_EMAIL_TAKEN' = err.code;
      expect(code).toBe('USER_EMAIL_TAKEN');
    }
    expect(hasCode(err, 'USER_EMAIL_TAKEN')).toBe(true);
    expect(hasCode({ code: 'RBAC_DENIED' }, 'RBAC_DENIED')).toBe(true);
    expect(hasCode(null, 'X')).toBe(false);
  });

  it('validates the definition', () => {
    expect(() => defineError('bad code', { status: 400 })).toThrow(TypeError);
    expect(() => defineError('OK_CODE', { status: 302 })).toThrow(TypeError);
  });

  it('isAppError recognises the brand across package copies', () => {
    const foreign = Object.assign(new Error('x'), { [Symbol.for('aspec.errors.AppError')]: true });
    expect(isAppError(foreign)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });
});
