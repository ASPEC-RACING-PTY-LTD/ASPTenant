import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  checkCoverage,
  createTempDir,
  createTestClock,
  defineAspecVitestConfig,
  isolateEnv,
  useFakeTimers,
  withEnv,
  withTempDir,
} from '../src/index.js';

describe('environment isolation', () => {
  it('restores additions and deletions exactly', () => {
    process.env.ASPEC_ENV_KEEP = 'keep';
    delete process.env.ASPEC_ENV_TEMP;
    withEnv({ ASPEC_ENV_TEMP: '1', ASPEC_ENV_KEEP: undefined }, () => {
      expect(process.env.ASPEC_ENV_TEMP).toBe('1');
      expect(process.env.ASPEC_ENV_KEEP).toBeUndefined();
      process.env.ASPEC_ENV_INNER = 'x';
    });
    expect(process.env.ASPEC_ENV_TEMP).toBeUndefined();
    expect(process.env.ASPEC_ENV_KEEP).toBe('keep');
    expect(process.env.ASPEC_ENV_INNER).toBeUndefined();
    delete process.env.ASPEC_ENV_KEEP;
  });

  it('isolateEnv restores on dispose', () => {
    process.env.ASPEC_ISO = 'before';
    {
      using env = isolateEnv({ ASPEC_ISO: 'during' });
      expect(process.env.ASPEC_ISO).toBe('during');
      env.unset('ASPEC_ISO');
      expect(process.env.ASPEC_ISO).toBeUndefined();
    }
    expect(process.env.ASPEC_ISO).toBe('before');
    delete process.env.ASPEC_ISO;
  });

  it('creates temporary directories with cleanup', async () => {
    let path = '';
    await withTempDir(async (dir) => {
      path = dir.path;
      await dir.writeFile('a.txt', 'hello');
      expect(await dir.readFile('a.txt')).toBe('hello');
    });
    expect(existsSync(path)).toBe(false);

    const dir = await createTempDir({ prefix: 'aspec-t' });
    await dir.mkdir('nested');
    await dir.cleanup();
    expect(existsSync(dir.path)).toBe(false);
  });
});

describe('clock and fake timers', () => {
  it('controls a Clock and wraps Vitest fake timers', async () => {
    const clock = createTestClock(Date.UTC(2026, 0, 1));
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1));
    clock.advance(1000);
    expect(clock.now()).toBe(Date.UTC(2026, 0, 1) + 1000);

    const timers = useFakeTimers(vi);
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 50);
    expect(fired).toBe(false);
    timers.advance(50);
    expect(fired).toBe(true);
    timers.restore();
  });
});

describe('coverage config', () => {
  it('builds a Vitest coverage config shape and checks thresholds', () => {
    const config = defineAspecVitestConfig({
      setupFiles: ['test/setup.ts'],
      coverage: { thresholds: { lines: 90 } },
    });
    expect(config.test.coverage.provider).toBe('v8');
    expect(config.test.coverage.reporter).toEqual(
      expect.arrayContaining(['text', 'lcov', 'json-summary']),
    );
    expect(config.test.coverage.thresholds?.lines).toBe(90);

    const summary = {
      total: {
        lines: { total: 100, covered: 80, skipped: 0, pct: 80 },
        statements: { total: 100, covered: 80, skipped: 0, pct: 80 },
        functions: { total: 10, covered: 8, skipped: 0, pct: 80 },
        branches: { total: 20, covered: 15, skipped: 0, pct: 75 },
      },
      files: {},
      file: 'coverage/coverage-summary.json',
    };
    expect(checkCoverage(summary, { lines: 85 }).ok).toBe(false);
    expect(checkCoverage(summary, { lines: 80 }).ok).toBe(true);
  });
});
