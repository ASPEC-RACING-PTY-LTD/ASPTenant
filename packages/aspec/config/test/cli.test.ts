import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

describe('CLI', () => {
  it('prints help', async () => {
    expect(await runCli(['--help'])).toBe(0);
  });

  it('check, docs and example against a user config module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-cli-'));
    try {
      const fieldsUrl = pathToFileURL(join(process.cwd(), 'src/fields.ts')).href;
      const modPath = join(dir, 'app-config.mjs');
      await writeFile(
        modPath,
        `import { env } from '${fieldsUrl}';
export const shape = {
  port: env.port('PORT').default(3000),
  secret: env.string('APP_SECRET').secret(),
};
`,
      );
      const docsCode = await runCli(['docs', modPath]);
      expect(docsCode).toBe(0);
      const exampleCode = await runCli(['example', modPath]);
      expect(exampleCode).toBe(0);
      const prev = process.env.APP_SECRET;
      process.env.APP_SECRET = 'test-secret-value';
      try {
        expect(await runCli(['check', modPath])).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.APP_SECRET;
        else process.env.APP_SECRET = prev;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
