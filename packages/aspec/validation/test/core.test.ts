import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigValidationError,
  formatPath,
  parse,
  parseSync,
  refine,
  rules,
  toJsonPointer,
  toProblemDetails,
  ValidationError,
  ValidationSchemaError,
  validate,
  validateConfig,
  validateSync,
} from '../src/index.js';

describe('validate with zod', () => {
  const schema = z.object({
    name: z.string().min(1),
    nested: z.object({ age: z.number().int().positive() }),
    tags: z.array(z.string()).optional(),
  });

  it('returns typed success', async () => {
    const result = await validate(schema, { name: 'Ada', nested: { age: 36 } });
    expect(result).toEqual({
      success: true,
      value: { name: 'Ada', nested: { age: 36 } },
    });
  });

  it('returns path, pointer, code and received', async () => {
    const result = await validate(schema, { name: '', nested: { age: 'x' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const age = result.issues.find((i) => i.pointer === '/nested/age');
    expect(age).toMatchObject({
      path: ['nested', 'age'],
      pointer: '/nested/age',
      code: 'invalid_type',
      received: 'string',
    });
    expect(toJsonPointer(['nested', 'age'])).toBe('/nested/age');
    expect(formatPath(['nested', 'age'])).toBe('nested.age');
  });

  it('validateSync works for sync schemas', () => {
    const result = validateSync(schema, { name: 'Ada', nested: { age: 1 } });
    expect(result.success).toBe(true);
  });

  it('parse throws ValidationError', async () => {
    await expect(parse(schema, { name: 1, nested: { age: 1 } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('validate with valibot', () => {
  const schema = v.object({
    email: v.pipe(v.string(), v.email()),
    profile: v.object({ role: v.picklist(['admin', 'user']) }),
  });

  it('succeeds and fails with pointers', async () => {
    const ok = await validate(schema, { email: 'a@b.co', profile: { role: 'user' } });
    expect(ok.success).toBe(true);
    const bad = await validate(schema, { email: 'nope', profile: { role: 'x' } });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.issues.some((i) => i.pointer === '/email')).toBe(true);
    expect(bad.issues.some((i) => i.pointer === '/profile/role')).toBe(true);
  });
});

describe('refine and rules', () => {
  const base = z.object({
    password: z.string().min(8),
    confirm: z.string(),
    start: z.string(),
    end: z.string(),
  });

  it('aggregates sync custom rules', () => {
    const schema = refine(base, [
      rules.fieldsMatch('password', 'confirm'),
      rules.dateOrder('start', 'end'),
    ]);
    const result = validateSync(schema, {
      password: 'password1',
      confirm: 'password2',
      start: '2026-01-02',
      end: '2026-01-01',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((i) => i.code).sort()).toEqual(['date_order', 'fields_mismatch']);
  });

  it('supports async rules', async () => {
    const schema = refine(z.object({ username: z.string() }), [
      rules.unique('username', async (u) => u !== 'taken'),
    ]);
    const bad = await validate(schema, { username: 'taken' });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    expect(bad.issues[0]?.code).toBe('not_unique');
    await expect(async () => validateSync(schema, { username: 'ok' })).rejects.toBeInstanceOf(
      ValidationSchemaError,
    );
  });
});

describe('messages and problem details', () => {
  it('customises messages by code', async () => {
    const schema = z.object({ n: z.number() });
    const result = await validate(
      schema,
      { n: 'x' },
      {
        messages: { invalid_type: 'Must be a number' },
      },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues[0]?.message).toBe('Must be a number');
  });

  it('toProblemDetails includes errors extension', async () => {
    const schema = z.object({ a: z.string() });
    try {
      await parse(schema, { a: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problem = toProblemDetails(err as ValidationError, { instance: '/x' });
      expect(problem).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        instance: '/x',
      });
      expect(problem.errors?.length).toBeGreaterThan(0);
      expect((err as ValidationError).expose).toBe(true);
    }
  });

  it('supports status 422', () => {
    const err = new ValidationError([{ path: [], pointer: '', message: 'x', code: 'x' }], {
      status: 422,
    });
    expect(err.status).toBe(422);
  });
});

describe('validateConfig', () => {
  const schema = z.object({
    port: z.coerce.number().int().positive(),
    password: z.string().min(8),
  });

  it('returns typed config', () => {
    const cfg = validateConfig(schema, { port: '3000', password: 'password1' }, { name: 'app' });
    expect(cfg).toEqual({ port: 3000, password: 'password1' });
  });

  it('aggregates a readable report and sanitises sensitive keys', () => {
    expect(() =>
      validateConfig(schema, { port: 'no', password: 'short' }, { name: 'app' }),
    ).toThrow(ConfigValidationError);
    try {
      validateConfig(schema, { port: 'no', password: 'short' }, { name: 'app' });
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.report).toContain('Invalid configuration for app');
      expect(e.report).toContain('port');
      const pwd = e.issues.find((i) => i.path[0] === 'password');
      expect(pwd?.message).toBe('Invalid value');
      expect(e.expose).toBe(false);
    }
  });
});

describe('parseSync', () => {
  it('returns value', () => {
    expect(parseSync(z.string(), 'hi')).toBe('hi');
  });
});
