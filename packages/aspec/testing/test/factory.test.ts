import { describe, expect, it } from 'vitest';
import {
  createRandom,
  defineFactory,
  getSeed,
  memoryPersistence,
  resetSequences,
  setSeed,
} from '../src/index.js';

describe('factories and random', () => {
  it('is deterministic for a fixed seed and sequence', () => {
    setSeed('fixed');
    resetSequences();
    const users = defineFactory(
      (ctx) => ({
        id: ctx.random.uuid(),
        email: ctx.random.email(),
        n: ctx.sequence,
        role: 'member' as string,
      }),
      { name: 'user', traits: { admin: { role: 'admin' } } },
    );
    const a = users.build(undefined, { traits: ['admin'] });
    resetSequences();
    setSeed('fixed');
    const b = users.build(undefined, { traits: ['admin'] });
    expect(a).toEqual(b);
    expect(a.n).toBe(1);
    expect(a.role).toBe('admin');
    expect(getSeed()).toBe('fixed');
  });

  it('supports overrides, associations and persistence', async () => {
    resetSequences();
    setSeed('assoc');
    const orgs = defineFactory((ctx) => ({ id: ctx.random.uuid(), name: ctx.random.word() }), {
      name: 'org',
    });
    const users = defineFactory(
      (ctx) => ({
        id: ctx.random.uuid(),
        orgId: ctx.association(orgs, { select: (o) => o.id }),
        email: ctx.random.email(),
      }),
      { name: 'member' },
    );
    const built = users.build({ email: 'ada@example.test' });
    expect(built.email).toBe('ada@example.test');
    expect(built.orgId).toMatch(/^[0-9a-f-]{36}$/);

    const store = memoryPersistence<{ id: string; email: string }>();
    const persisted = defineFactory(
      (ctx) => ({ id: ctx.random.uuid(), email: ctx.random.email() }),
      {
        name: 'persist',
        adapter: store,
      },
    );
    const row = await persisted.create({ email: 'saved@example.test' });
    expect(store.records).toHaveLength(1);
    expect(row.email).toBe('saved@example.test');
  });

  it('exposes seeded generators without faker', () => {
    const r = createRandom('gen');
    expect(r.fullName()).toMatch(/\w+ \w+/);
    expect(r.email()).toMatch(/@example\.test$/);
    expect(r.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.paragraph(2).split('. ').length).toBeGreaterThan(0);
    expect(r.int(1, 3)).toBeGreaterThanOrEqual(1);
    expect(r.date().getTime()).toBeGreaterThan(0);
  });
});
