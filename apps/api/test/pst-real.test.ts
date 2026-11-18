import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_KIND } from '../src/imports/pst.js';
import type { Job } from '../src/jobs/store.js';
import {
  addVerifiedDomain,
  asTenant,
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
    await addVerifiedDomain(ctx, headers, 'example.com');
    const mailbox = (await (
      await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'shared', primaryAddress: 'archive@example.com' }),
      })
    ).json()) as { id: string };
    const imports = ctx.platform.imports;
    const job = await asTenant(ctx, () =>
      imports.create({ mailboxId: mailbox.id, filename: 'enron.pst', size: 1 }, 'test'),
    );
    copyFileSync(sample, job.data.path);
    await asTenant(ctx, () => imports.jobs.update(job.id, { status: 'queued' }));
    ctx.platform.imports.kick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.platform.imports.idle();
    const [done] = await asTenant(ctx, () =>
      imports.jobs.list<unknown, { imported: number; skipped: number; failed: number }>(
        IMPORT_KIND,
      ),
    );
    expect(done?.status).toBe('succeeded');
    expect(done?.progress.imported).toBeGreaterThan(10);
    const folders = await asTenant(ctx, () => ctx.platform.mail.messages.listFolders(mailbox.id));
    expect(folders.length).toBeGreaterThan(6);

    await asTenant(ctx, () => imports.retry(job.id));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.platform.imports.idle();
    const [again] = await asTenant(ctx, () =>
      imports.jobs.list<unknown, { imported: number; skipped: number }>(IMPORT_KIND),
    );
    expect(again?.progress.imported).toBe(0);
    expect(again?.progress.skipped).toBeGreaterThan(10);
  }, 120_000);

  it('keeps the upload in the database on redundancy nodes, so any node can run it', async () => {
    ctx = await createTestContext({ env: { NODE_NAME: 'node-a', NODE_ROLE: 'primary' } });
    const headers = { cookie: await setupOwner(ctx) };
    await addVerifiedDomain(ctx, headers, 'example.com');
    const mailbox = (await (
      await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'shared', primaryAddress: 'archive@example.com' }),
      })
    ).json()) as { id: string };
    const bytes = readFileSync(sample);
    const imports = ctx.platform.imports;
    const job = await asTenant(ctx, () =>
      imports.create({ mailboxId: mailbox.id, filename: 'enron.pst', size: bytes.length }, 'test'),
    );
    const size = 1024 * 1024;
    for (let offset = 0; offset < bytes.length; offset += size) {
      await asTenant(ctx, () =>
        imports.chunk(job.id, offset, bytes.subarray(offset, offset + size)),
      );
    }
    // Nothing on this node's disk: the leader rebuilds the file from the database.
    expect(existsSync(job.data.path)).toBe(false);
    // The queue starts after the upload commits; wait for the import to finish.
    let done: Job<unknown, { imported: number }> | undefined;
    for (let i = 0; i < 600; i += 1) {
      await ctx.platform.imports.idle();
      [done] = await asTenant(ctx, () =>
        imports.jobs.list<unknown, { imported: number }>(IMPORT_KIND),
      );
      if (done && done.status !== 'queued' && done.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(done?.status).toBe('succeeded');
    expect(done?.progress.imported).toBeGreaterThan(10);
    const left = await ctx.database.query('SELECT count(*) AS n FROM aspectenant_import_chunks');
    expect(Number(left.rows[0]?.n)).toBe(0);
  }, 120_000);
});
