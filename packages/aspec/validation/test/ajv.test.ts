import { describe, expect, it } from 'vitest';
import { fromJsonSchema } from '../src/ajv.js';
import { validate, validateSync } from '../src/index.js';

describe('fromJsonSchema (ajv)', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['id', 'count'],
    properties: {
      id: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0 },
      nested: {
        type: 'object',
        properties: { flag: { type: 'boolean' } },
        required: ['flag'],
      },
    },
  };

  it('validates successfully', () => {
    const v = fromJsonSchema<{ id: string; count: number }>(schema);
    const result = validateSync(v, { id: 'a', count: 2 });
    expect(result).toEqual({ success: true, value: { id: 'a', count: 2 } });
  });

  it('reports paths and codes', async () => {
    const v = fromJsonSchema(schema);
    const result = await validate(v, { id: 1, count: -1, nested: { flag: 'x' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.some((i) => i.pointer === '/id' && i.code === 'type')).toBe(true);
    expect(result.issues.some((i) => i.pointer === '/count')).toBe(true);
    expect(result.issues.some((i) => i.pointer === '/nested/flag')).toBe(true);
  });
});
