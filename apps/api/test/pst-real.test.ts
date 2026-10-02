import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_KIND } from '../src/imports/pst.js';
import {
  createTestContext,
  destroyTestContext,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

const require = createRequire(import.meta.url);
const sample = join(
  dirname(require.resolve('pst-extractor/package.json')),
  'example/testdata/enron.pst',
);

describe.skipIf(!existsSync(sample))('PST import with a real file', () => {
  let ctx: TestContext;
  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('imports folders and messages, and a second run skips everything', async () => {
    ctx = await createTestContext();
    const headers = { cookie: await setupOwner(ctx) };
    await request(ctx, '/api/v1/domains', {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname: 'example.com' }),
    });
    const mailbox = (await (
      await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'shared', primaryAddress: 'archive@example.com' }),
      })
    ).json()) as { id: string };
    const job = await ctx.platform.imports.create(
      { mailboxId: mailbox.id, filename: 'enron.pst', size: 1 },
      'test',
    );
    copyFileSync(sample, job.data.path);
    await ctx.platform.imports.jobs.update(job.id, { status: 'queued' });
    ctx.platform.imports.kick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.platform.imports.idle();
    const [done] = await ctx.platform.imports.jobs.list<
      unknown,
      { imported: number; skipped: number; failed: number }
    >(IMPORT_KIND);
    expect(done?.status).toBe('succeeded');
    expect(done?.progress.imported).toBeGreaterThan(10);
    const folders = await ctx.platform.mail.messages.listFolders(mailbox.id);
    expect(folders.length).toBeGreaterThan(6);

    await ctx.platform.imports.retry(job.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.platform.imports.idle();
    const [again] = await ctx.platform.imports.jobs.list<
      unknown,
      { imported: number; skipped: number }
    >(IMPORT_KIND);
    expect(again?.progress.imported).toBe(0);
    expect(again?.progress.skipped).toBeGreaterThan(10);
  }, 120_000);
});
