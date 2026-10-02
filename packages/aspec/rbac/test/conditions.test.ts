import { describe, expect, it } from 'vitest';
import { evaluateCondition, RbacInvalidPolicyError, validateCondition } from '../src/index.js';

describe('ABAC conditions', () => {
  const input = {
    subject: { id: 'u1', orgId: 'org-a', attributes: { tier: 'pro', tags: ['a', 'b'] } },
    resource: { type: 'posts', id: 'p1', attributes: { score: 10, title: 'Hello world' } },
    context: { scope: { orgId: 'org-a' }, env: 'prod' },
  };

  const cases: { name: string; condition: unknown; expected: boolean }[] = [
    { name: 'eq', condition: { attr: 'subject.orgId', op: 'eq', value: 'org-a' }, expected: true },
    {
      name: 'neq',
      condition: { attr: 'subject.orgId', op: 'neq', value: 'org-b' },
      expected: true,
    },
    {
      name: 'in',
      condition: { attr: 'subject.attributes.tier', op: 'in', value: ['pro', 'ent'] },
      expected: true,
    },
    {
      name: 'notIn',
      condition: { attr: 'subject.attributes.tier', op: 'notIn', value: ['free'] },
      expected: true,
    },
    {
      name: 'lt',
      condition: { attr: 'resource.attributes.score', op: 'lt', value: 20 },
      expected: true,
    },
    {
      name: 'lte',
      condition: { attr: 'resource.attributes.score', op: 'lte', value: 10 },
      expected: true,
    },
    {
      name: 'gt',
      condition: { attr: 'resource.attributes.score', op: 'gt', value: 5 },
      expected: true,
    },
    {
      name: 'gte',
      condition: { attr: 'resource.attributes.score', op: 'gte', value: 10 },
      expected: true,
    },
    {
      name: 'contains',
      condition: { attr: 'resource.attributes.title', op: 'contains', value: 'world' },
      expected: true,
    },
    {
      name: 'startsWith',
      condition: { attr: 'resource.attributes.title', op: 'startsWith', value: 'Hello' },
      expected: true,
    },
    { name: 'exists true', condition: { attr: 'subject.orgId', op: 'exists' }, expected: true },
    { name: 'exists false', condition: { attr: 'subject.teamIds', op: 'exists' }, expected: false },
    {
      name: 'all',
      condition: {
        all: [
          { attr: 'subject.orgId', op: 'eq', value: 'org-a' },
          { attr: 'context.env', op: 'eq', value: 'prod' },
        ],
      },
      expected: true,
    },
    {
      name: 'any',
      condition: {
        any: [
          { attr: 'subject.orgId', op: 'eq', value: 'org-x' },
          { attr: 'context.env', op: 'eq', value: 'prod' },
        ],
      },
      expected: true,
    },
    {
      name: 'not',
      condition: { not: { attr: 'subject.orgId', op: 'eq', value: 'org-b' } },
      expected: true,
    },
    {
      name: 'ref value',
      condition: { attr: 'resource.orgId', op: 'eq', value: { ref: 'subject.orgId' } },
      expected: false,
    },
  ];

  for (const c of cases) {
    it(`evaluates ${c.name}`, () => {
      const condition = validateCondition(c.condition);
      expect(evaluateCondition(condition, input)).toBe(c.expected);
    });
  }

  it('rejects malformed and oversized policies', () => {
    expect(() => validateCondition({ attr: '__proto__.x', op: 'eq', value: 1 })).toThrow(
      RbacInvalidPolicyError,
    );
    expect(() => validateCondition({ attr: 'subject.id', op: 'regex', value: '.*' })).toThrow(
      RbacInvalidPolicyError,
    );
    let cur: Record<string, unknown> = { attr: 'subject.id', op: 'eq', value: 1 };
    for (let i = 0; i < 20; i++) {
      cur = { all: [cur] };
    }
    expect(() => validateCondition(cur)).toThrow(RbacInvalidPolicyError);
  });
});
