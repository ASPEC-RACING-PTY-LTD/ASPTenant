import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../src/define.js';
import { ConfigError } from '../src/errors.js';
import { env } from '../src/fields.js';

const shape = {
  flags: env.json(
    'FLAGS',
    v.object({ beta: v.boolean(), limit: v.pipe(v.number(), v.minValue(1)) }),
  ),
};

describe('Valibot Standard Schema', () => {
  it('parses a JSON field through a Valibot schema', () => {
    const config = defineConfig(shape, {
      ignoreFiles: true,
      processEnv: { FLAGS: '{"beta":true,"limit":5}' },
    });
    expect(config.flags).toEqual({ beta: true, limit: 5 });
  });

  it('reports Valibot issues against the variable name', () => {
    try {
      defineConfig(shape, { ignoreFiles: true, processEnv: { FLAGS: '{"beta":"yes","limit":0}' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).details.issues;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => issue.path.startsWith('FLAGS'))).toBe(true);
    }
  });
});
