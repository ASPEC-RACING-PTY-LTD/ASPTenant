import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '../src/errors.js';
import {
  applyFieldPatch,
  assertFieldDefinitions,
  type FieldDefinitions,
  mergeWithDefaults,
  type StandardSchemaV1,
} from '../src/fields.js';
import { createUsers } from '../src/service.js';
import type { UsersStore } from '../src/store.js';
import { createMemoryUsersStore } from '../src/stores/memory.js';

const asyncSchema: StandardSchemaV1<{ street: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      const v = value as { street?: unknown };
      if (typeof v === 'object' && v !== null && typeof v.street === 'string')
        return { value: { street: v.street.trim() } };
      return { issues: [{ message: 'street is required', path: [{ key: 'street' }] }] };
    },
  },
};

const defs: FieldDefinitions = {
  tags: { type: 'string-array', maxItems: 2, enum: ['a', 'b', 'c'] },
  extra: { type: 'json', maxBytes: 20 },
  count: { type: 'number', min: 0, default: 1 },
  code: { type: 'string', pattern: '^[A-Z]{3}$' },
  address: { schema: asyncSchema },
  required: { type: 'string', required: true },
};

async function patch(value: unknown, current: Record<string, unknown> = {}) {
  const issues: ValidationIssue[] = [];
  const out = await applyFieldPatch(
    defs,
    current,
    value,
    { path: 'f', selfService: false, editableByDefault: true, allowUnknown: false },
    issues,
  );
  return { out, issues };
}

describe('field definitions', () => {
  it('validates built-in types', async () => {
    expect((await patch({ tags: ['a', 'b'] })).issues).toEqual([]);
    expect((await patch({ tags: ['a', 'b', 'c'] })).issues[0]?.message).toMatch(/at most 2/);
    expect((await patch({ tags: ['z'] })).issues[0]?.message).toMatch(/one of/);
    expect((await patch({ extra: { a: 'x'.repeat(30) } })).issues[0]?.message).toMatch(/bytes/);
    expect((await patch({ extra: { when: new Date() } })).issues[0]?.message).toMatch(/JSON/);
    expect((await patch({ count: -1 })).issues[0]?.message).toMatch(/at least 0/);
    expect((await patch({ count: Number.NaN })).issues[0]?.message).toMatch(/finite/);
    expect((await patch({ code: 'abc' })).issues[0]?.message).toMatch(/format/);
    expect((await patch({ code: 'ABC' })).out.code).toBe('ABC');
    expect((await patch({ required: null })).issues[0]?.message).toBe('is required');
    expect((await patch([])).issues[0]?.message).toBe('must be an object');
  });

  it('supports async Standard Schema validators and uses their output', async () => {
    expect((await patch({ address: { street: '  Main St ' } })).out.address).toEqual({
      street: 'Main St',
    });
    expect((await patch({ address: {} })).issues).toEqual([
      { path: 'f.address.street', message: 'street is required' },
    ]);
  });

  it('merges defaults without mutating definitions', () => {
    const merged = mergeWithDefaults(defs, { code: 'XYZ' });
    expect(merged).toEqual({ count: 1, code: 'XYZ' });
  });

  it('rejects unknown types at construction', () => {
    expect(() => assertFieldDefinitions('x', { a: { type: 'date' } as never })).toThrow(
      /type must be/,
    );
  });
});

describe('concurrent updates', () => {
  it('retries internal read-modify-write cycles so concurrent patches are not lost', async () => {
    const store: UsersStore = createMemoryUsersStore();
    const users = createUsers({
      store,
      preferences: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`k${i}`, { type: 'integer' as const, default: 0 }]),
      ),
    });
    const u = await users.createUser({ email: 'c@example.com' });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => users.updatePreferences(u.id, { [`k${i}`]: i + 1 })),
    );
    expect(await users.getPreferences(u.id)).toEqual({ k0: 1, k1: 2, k2: 3, k3: 4, k4: 5 });
    expect((await users.getUser(u.id)).version).toBe(6);
  });

  it('reports a conflict when an expected version is stale under concurrency', async () => {
    const users = createUsers({ store: createMemoryUsersStore() });
    const u = await users.createUser({ email: 'd@example.com' });
    const results = await Promise.allSettled([
      users.updateProfile(u.id, { displayName: 'A' }, { expectedVersion: 1 }),
      users.updateProfile(u.id, { displayName: 'B' }, { expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('USERS_VERSION_CONFLICT');
  });
});
