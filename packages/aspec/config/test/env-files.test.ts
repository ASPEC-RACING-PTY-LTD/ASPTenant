import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../src/define.js';
import { env } from '../src/fields.js';
import { loadEnv } from '../src/load-env.js';

describe('dotenv precedence and _FILE', () => {
  it('applies documented precedence; real env wins; skips .env.local in test', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-config-'));
    try {
      await writeFile(join(dir, '.env'), 'A=from-env\nB=from-env\nC=from-env\n');
      await writeFile(join(dir, '.env.local'), 'B=from-local\n');
      await writeFile(join(dir, '.env.development'), 'C=from-development\n');
      await writeFile(join(dir, '.env.development.local'), 'C=from-development-local\n');

      const dev = loadEnv({
        cwd: dir,
        nodeEnv: 'development',
        processEnv: { C: 'from-process' },
      });
      expect(dev.A).toBe('from-env');
      expect(dev.B).toBe('from-local');
      expect(dev.C).toBe('from-process');

      const testEnv = loadEnv({
        cwd: dir,
        nodeEnv: 'test',
        processEnv: {},
      });
      expect(testEnv.B).toBe('from-env');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads NAME_FILE when NAME is unset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-config-'));
    try {
      const secretPath = join(dir, 'db-url');
      await writeFile(secretPath, 'postgres://file/db\n');
      const config = defineConfig(
        { databaseUrl: env.url('DATABASE_URL').secret() },
        {
          ignoreFiles: true,
          processEnv: { DATABASE_URL_FILE: secretPath },
        },
      );
      expect(config.databaseUrl.reveal()).toBe('postgres://file/db');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expands variables only when enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-config-'));
    try {
      await writeFile(join(dir, '.env'), 'HOST=localhost\nURL=https://$HOST/app\n');
      const envMap = loadEnv({
        cwd: dir,
        nodeEnv: 'development',
        expand: true,
        processEnv: {},
      });
      expect(envMap.URL).toBe('https://localhost/app');
      const noExpand = loadEnv({
        cwd: dir,
        nodeEnv: 'development',
        expand: false,
        processEnv: {},
      });
      expect(noExpand.URL).toBe('https://$HOST/app');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('file secrets provider wiring via defineConfig cwd', () => {
  it('loads dotenv from cwd in defineConfig', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-config-'));
    try {
      await writeFile(join(dir, '.env'), 'PORT=4010\n');
      const config = defineConfig(
        { port: env.port('PORT') },
        { cwd: dir, processEnv: { NODE_ENV: 'development' } },
      );
      expect(config.port).toBe(4010);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
