import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir, runScaffoldCli, scaffoldGenerate, scaffoldInit } from '../src/index.js';

describe('scaffolding', () => {
  it('scaffolds TypeScript ESM projects without overwrite', async () => {
    const dir = await createTempDir({ prefix: 'aspec-sc' });
    await dir.writeFile(
      'package.json',
      JSON.stringify(
        { name: 'demo', type: 'module', devDependencies: { typescript: '5.0.0', vitest: '5.0.0' } },
        null,
        2,
      ),
    );
    await dir.writeFile('tsconfig.json', '{}');

    const first = await scaffoldInit({
      cwd: dir.path,
      importSpecifier: new URL('../src/index.ts', import.meta.url).href,
    });
    expect(first.ok).toBe(true);
    expect(first.files.every((f) => f.action === 'create')).toBe(true);
    expect(first.detection.language).toBe('typescript');
    expect(first.detection.moduleSystem).toBe('esm');

    const config = await readFile(join(dir.path, 'vitest.config.ts'), 'utf8');
    expect(config).toContain('defineAspecVitestConfig');

    const dry = await scaffoldInit({ cwd: dir.path, dryRun: true });
    expect(dry.files.every((f) => f.action === 'conflict' || f.action === 'skip')).toBe(true);

    await expect(scaffoldInit({ cwd: dir.path })).rejects.toThrow(/refused to overwrite/);

    const generated = await scaffoldGenerate({
      cwd: dir.path,
      kind: 'api',
      name: 'orders',
      importSpecifier: '@aspec/testing',
    });
    expect(generated.files[0]?.path).toBe('test/orders.api.test.ts');
    await dir.cleanup();
  });

  it('scaffolds JavaScript CommonJS with dry-run and json CLI', async () => {
    const dir = await createTempDir({ prefix: 'aspec-js' });
    await dir.writeFile('package.json', JSON.stringify({ name: 'js-demo' }, null, 2));

    const planned = await scaffoldInit({
      cwd: dir.path,
      language: 'javascript',
      moduleSystem: 'commonjs',
      dryRun: true,
    });
    expect(planned.dryRun).toBe(true);
    expect(
      planned.files.some((f) => f.path.endsWith('.cjs') || f.path.includes('vitest.config')),
    ).toBe(true);
    expect(planned.files.every((f) => f.action === 'create')).toBe(true);

    const code = await runScaffoldCli(['init', '--dry-run', '--json'], { cwd: dir.path });
    expect(code).toBe(0);
    await dir.cleanup();
  });
});
