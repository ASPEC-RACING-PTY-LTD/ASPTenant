import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addVerifiedDomain,
  createTestContext,
  destroyTestContext,
  json,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

/** An in-memory bucket standing in for Cloudflare R2. */
function fakeBucket() {
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  let down = false;
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    if (down) throw new Error('bucket unreachable');
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    const key = String(input.Key ?? '');
    switch (name) {
      case 'PutObjectCommand': {
        const body = input.Body;
        objects.set(key, {
          body: typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array),
          modified: new Date(),
        });
        return {};
      }
      case 'HeadObjectCommand':
      case 'GetObjectCommand': {
        const item = objects.get(key);
        if (!item) throw new Error('NoSuchKey');
        return name === 'HeadObjectCommand' ? {} : { Body: Readable.from([item.body]) };
      }
      case 'DeleteObjectCommand':
        objects.delete(key);
        return {};
      case 'ListObjectsV2Command': {
        const prefix = String(input.Prefix ?? '');
        return {
          Contents: [...objects]
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => ({ Key: k, LastModified: v.modified, Size: v.body.length })),
          IsTruncated: false,
        };
      }
      default:
        throw new Error(`Unexpected ${name}`);
    }
  });
  return {
    objects,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

const RAW = (n: number) =>
  [
    'From: Alice <alice@outside.test>',
    'To: owner@example.com',
    `Subject: Message ${n}`,
    `Message-ID: <m${n}@outside.test>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Body number ${n}.`,
    '',
  ].join('\r\n');

describe('message storage in an R2 or S3 bucket', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyTestContext(ctx);
  });

  async function setup() {
    const cookie = await setupOwner(ctx);
    const headers = { cookie };
    await addVerifiedDomain(ctx, headers, 'example.com');
    const users = await json<{ items: Array<{ id: string }> }>(
      await request(ctx, '/api/v1/users', { headers }),
    );
    const mailbox = await json<{ id: string }>(
      await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'user',
          userId: users.items[0]?.id,
          primaryAddress: 'owner@example.com',
        }),
      }),
    );
    const token = (
      await json<{ token: string }>(
        await request(ctx, '/api/v1/mail/settings/ingest-token', { method: 'POST', headers }),
      )
    ).token;
    const ingest = async (n: number) => {
      const response = await request(ctx, '/api/v1/mail/ingest', {
        method: 'POST',
        body: RAW(n),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'message/rfc822',
          'x-envelope-to': 'owner@example.com',
        },
      });
      expect(response.status).toBe(200);
    };
    const list = async () =>
      (
        await json<{ items: Array<{ id: string; subject: string }> }>(
          await request(ctx, `/api/v1/mail/mailboxes/${mailbox.id}/messages?folder=INBOX`, {
            headers,
          }),
        )
      ).items;
    const body = async (id: string) =>
      json<{ text: string }>(await request(ctx, `/api/v1/mail/messages/${id}`, { headers }));
    const storage = (kind: 'database' | 's3') =>
      request(ctx, '/api/v1/message-storage', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          kind,
          endpoint: 'https://account.r2.cloudflarestorage.com',
          region: 'auto',
          bucket: 'mail',
          prefix: 'prod',
          accessKeyId: 'key',
          secretAccessKey: 'secret',
          forcePathStyle: false,
        }),
      });
    const view = async () =>
      json<{
        kind: string;
        inDatabase: { messages: number };
        inBucket: { messages: number };
      }>(await request(ctx, '/api/v1/message-storage', { headers }));
    return { headers, ingest, list, body, storage, view };
  }

  it('moves existing mail to the bucket, stores new mail there, and moves it back', async () => {
    const bucket = fakeBucket();
    const { ingest, list, body, storage, view } = await setup();
    await ingest(1);
    await ingest(2);
    expect((await view()).inDatabase.messages).toBe(2);

    expect((await storage('s3')).status).toBe(200);
    await ctx.platform.messageBodies.moveNow();
    let state = await view();
    expect(state.kind).toBe('s3');
    expect(state.inDatabase.messages).toBe(0);
    expect(state.inBucket.messages).toBe(2);
    expect([...bucket.objects.keys()].every((key) => key.startsWith('prod/messages/'))).toBe(true);

    // New mail goes straight to the bucket; reading works the same either way.
    await ingest(3);
    expect((await view()).inBucket.messages).toBe(3);
    for (const message of await list()) {
      const n = message.subject.replace('Message ', '');
      expect((await body(message.id)).text).toContain(`Body number ${n}.`);
    }
    // The originals are objects in the bucket, not rows in the database.
    expect(bucket.objects.size).toBe(3);

    // While the bucket is down, mail is still delivered and kept in the database.
    bucket.setDown(true);
    await ingest(4);
    bucket.setDown(false);
    expect((await view()).inDatabase.messages).toBe(1);
    await ctx.platform.messageBodies.moveNow();
    expect((await view()).inDatabase.messages).toBe(0);

    // Back to the database: every message comes home.
    expect((await storage('database')).status).toBe(200);
    await ctx.platform.messageBodies.moveNow();
    state = await view();
    expect(state.inBucket.messages).toBe(0);
    expect(state.inDatabase.messages).toBe(4);
    for (const message of await list()) {
      expect((await body(message.id)).text).toContain('Body number');
    }
  });

  it('refuses a bucket it cannot write to, and a bucket change while mail is in the old one', async () => {
    const bucket = fakeBucket();
    const { ingest, storage, headers } = await setup();
    bucket.setDown(true);
    expect((await storage('s3')).status).toBe(422);
    bucket.setDown(false);
    expect((await storage('s3')).status).toBe(200);
    await ingest(1);
    const change = await request(ctx, '/api/v1/message-storage', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        kind: 's3',
        endpoint: '',
        region: 'auto',
        bucket: 'other',
        prefix: '',
        accessKeyId: 'key',
        forcePathStyle: false,
      }),
    });
    expect(change.status).toBe(422);
  });

  it('is for platform operators only', async () => {
    fakeBucket();
    await setup();
    const bob = await request(ctx, '/api/v1/message-storage');
    expect(bob.status).toBe(401);
  });
});
