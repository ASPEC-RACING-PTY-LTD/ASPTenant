import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineConfig } from '../src/define.js';
import { generateEnvExample, generateMarkdownDocs, toJSONSchema } from '../src/docs.js';
import { ConfigError } from '../src/errors.js';
import { env } from '../src/fields.js';
import { redactConfig, Secret } from '../src/secret.js';

const shape = {
  port: env.port('PORT').default(3000),
  databaseUrl: env.url('DATABASE_URL', { protocols: ['postgres', 'postgresql'] }).secret(),
  logLevel: env.enum('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const).default('info'),
  allowedOrigins: env.list('ALLOWED_ORIGINS').default([]),
  features: {
    signup: env.boolean('FEATURE_SIGNUP').default(true),
  },
  timeout: env.duration('TIMEOUT').default(30_000),
  maxUpload: env.bytes('MAX_UPLOAD').default(10 * 1024 * 1024),
  email: env.email('ADMIN_EMAIL').optional(),
  count: env.integer('COUNT').default(1),
  ratio: env.number('RATIO').default(1.5),
  name: env.string('NAME', { min: 1, max: 32 }).default('app'),
  flags: env.json('FLAGS', z.object({ beta: z.boolean() })),
  custom: env.custom('CUSTOM', (raw) => {
    if (raw !== 'ok') return { path: 'CUSTOM', problem: 'bad', message: 'must be ok' };
    return raw;
  }),
};

describe('defineConfig builders', () => {
  it('loads defaults and typed values', () => {
    const config = defineConfig(shape, {
      ignoreFiles: true,
      processEnv: {
        DATABASE_URL: 'postgres://localhost/db',
        FLAGS: '{"beta":true}',
        CUSTOM: 'ok',
        TIMEOUT: '5m',
        MAX_UPLOAD: '2MB',
        FEATURE_SIGNUP: 'false',
        ALLOWED_ORIGINS: 'a.com, b.com',
      },
    });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.features.signup).toBe(false);
    expect(config.allowedOrigins).toEqual(['a.com', 'b.com']);
    expect(config.timeout).toBe(300_000);
    expect(config.maxUpload).toBe(2 * 1024 * 1024);
    expect(config.flags).toEqual({ beta: true });
    expect(config.databaseUrl).toBeInstanceOf(Secret);
    expect(config.databaseUrl.reveal()).toBe('postgres://localhost/db');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('aggregates errors without secret values', () => {
    try {
      defineConfig(shape, {
        ignoreFiles: true,
        processEnv: {
          DATABASE_URL: 'not-a-url',
          FLAGS: '{',
          CUSTOM: 'nope',
          PORT: '99999',
          LOG_LEVEL: 'verbose',
        },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.code).toBe('CONFIG_INVALID');
      const report = e.toReport();
      expect(report).not.toMatch(/not-a-url/);
      expect(e.details.issues.length).toBeGreaterThan(1);
      expect(JSON.stringify(e.toJSON())).not.toMatch(/not-a-url/);
    }
  });

  it('redacts Secret under console, JSON and inspect', () => {
    const config = defineConfig(
      { token: env.string('TOKEN').secret() },
      { ignoreFiles: true, processEnv: { TOKEN: 'super-secret-value' } },
    );
    expect(String(config.token)).toBe('[Secret]');
    expect(JSON.stringify(config)).toContain('[Secret]');
    expect(JSON.stringify(config)).not.toContain('super-secret-value');
    expect(inspect(config.token)).toContain('REDACTED');
    expect(inspect(config.token)).not.toContain('super-secret-value');
    expect(redactConfig(config)).toEqual({ token: '[Secret]' });
  });

  it('generates docs and .env.example without secrets', () => {
    const example = generateEnvExample(shape);
    expect(example).toContain('PORT=3000');
    expect(example).toMatch(/DATABASE_URL=\n/);
    expect(example).not.toContain('postgres://');
    const md = generateMarkdownDocs(shape);
    expect(md).toContain('DATABASE_URL');
    expect(md).toContain('*(secret)*');
    expect(md).not.toContain('postgres://');
    const schema = toJSONSchema(shape);
    expect(schema.properties).toHaveProperty('PORT');
  });
});
