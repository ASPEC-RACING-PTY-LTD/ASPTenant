import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('node:test compatibility', () => {
  it('runs a small node --test file that imports the built module', async () => {
    const distIndex = new URL('../dist/index.js', import.meta.url).href;
    // Require a prior build so the child process can import ESM without a TypeScript loader.
    await import(distIndex);

    const dir = await mkdtemp(join(tmpdir(), 'aspec-node-test-'));
    const testFile = join(dir, 'sample.test.mjs');
    await writeFile(
      testFile,
      `
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRandom, withEnv, defineFactory, resetSequences, setSeed } from ${JSON.stringify(distIndex)};

describe('node:test consumer', () => {
  it('uses factories and withEnv', () => {
    setSeed('node-test');
    resetSequences();
    const f = defineFactory((ctx) => ({ n: ctx.sequence }), { name: 'n' });
    assert.equal(f.build().n, 1);
    assert.equal(typeof createRandom('x').uuid(), 'string');
    withEnv({ ASPEC_NODE_TEST_FLAG: '1' }, () => {
      assert.equal(process.env.ASPEC_NODE_TEST_FLAG, '1');
    });
    assert.equal(process.env.ASPEC_NODE_TEST_FLAG, undefined);
  });
});
`,
      'utf8',
    );

    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ['--test', testFile], {
        env: process.env,
      });
      const output = `${stdout}\n${stderr}`;
      expect(output).toMatch(/# pass|pass /);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
