import { afterEach, describe, expect, it } from 'vitest';
import {
  addVerifiedDomain,
  createTestContext,
  destroyTestContext,
  json,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

interface Summary {
  id: string;
  folder: string;
  subject: string;
  seen: boolean;
  flagged: boolean;
}

const message = (id: string, subject: string, extra: string[] = []) =>
  [
    'From: Alice <alice@outside.test>',
    'To: owner@example.com',
    `Subject: ${subject}`,
    `Message-ID: <${id}@outside.test>`,
    'Date: Thu, 01 Oct 2026 10:00:00 +0000',
    ...extra,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Body of ${subject}.`,
    '',
  ].join('\r\n');

describe('mail app', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  /** Owner with owner@example.com and a shared info@example.com they are a member of. */
  async function setup() {
    ctx = await createTestContext();
    const cookie = await setupOwner(ctx);
    const headers = { cookie };
    await addVerifiedDomain(ctx, headers, 'example.com');
    const users = await json<{ items: Array<{ id: string }> }>(
      await request(ctx, '/api/v1/users', { headers }),
    );
    const ownerId = users.items[0]?.id ?? '';
    const own = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'user', userId: ownerId, primaryAddress: 'owner@example.com' }),
    });
    expect(own.status).toBe(201);
    const shared = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'shared',
        primaryAddress: 'info@example.com',
        displayName: 'Info desk',
      }),
    });
    expect(shared.status).toBe(201);
    const ownId = (await json<{ id: string }>(own)).id;
    const sharedId = (await json<{ id: string }>(shared)).id;
    const member = await request(ctx, `/api/v1/mail/admin/mailboxes/${sharedId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: ownerId }),
    });
    expect(member.status).toBeLessThan(300);
    const token = (
      await json<{ token: string }>(
        await request(ctx, '/api/v1/mail/settings/ingest-token', { method: 'POST', headers }),
      )
    ).token;
    const ingest = async (raw: string, to = 'owner@example.com') => {
      const response = await request(ctx, '/api/v1/mail/ingest', {
        method: 'POST',
        body: raw,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'message/rfc822',
          'x-envelope-to': to,
        },
      });
      expect(response.status).toBe(200);
    };
    const list = async (mailboxId: string, folder: string, query = '') =>
      (
        await json<{ items: Summary[] }>(
          await request(
            ctx,
            `/api/v1/mail/mailboxes/${mailboxId}/messages?folder=${encodeURIComponent(folder)}${query}`,
            { headers },
          ),
        )
      ).items;
    return { headers, ownId, sharedId, ingest, list };
  }

  it('saves, replaces, reopens and sends drafts', async () => {
    const { headers, ownId, list } = await setup();
    const draft = {
      mailboxId: ownId,
      to: ['someone@example.com'],
      bcc: ['info@example.com'],
      subject: 'Plan',
      text: 'First version',
      html: '<p>First version</p>',
    };
    const first = await request(ctx, '/api/v1/mail/drafts', {
      method: 'PUT',
      headers,
      body: JSON.stringify(draft),
    });
    expect(first.status).toBe(200);
    const firstId = (await json<{ id: string }>(first)).id;

    const second = await request(ctx, '/api/v1/mail/drafts', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...draft, text: 'Second version', draftId: firstId }),
    });
    const secondId = (await json<{ id: string }>(second)).id;
    const drafts = await list(ownId, 'Drafts');
    expect(drafts.map((item) => item.id)).toEqual([secondId]);

    // Opening a draft keeps it unread state alone and returns its Bcc line.
    const opened = await json<{ bcc: Array<{ address: string }>; text: string; draft: boolean }>(
      await request(ctx, `/api/v1/mail/messages/${secondId}?markRead=0`, { headers }),
    );
    expect(opened.bcc.map((item) => item.address)).toEqual(['info@example.com']);
    expect(opened.text).toContain('Second version');
    expect(opened.draft).toBe(true);

    // A draft id from another folder is refused.
    const wrong = await request(ctx, '/api/v1/mail/drafts', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...draft, draftId: 'not-a-draft' }),
    });
    expect(wrong.status).toBe(404);

    // someone@example.com does not exist, so send to the shared mailbox instead.
    const sent = await request(ctx, '/api/v1/mail/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...draft, to: ['info@example.com'], bcc: [], draftId: secondId }),
    });
    expect(sent.status).toBe(201);
    expect(await list(ownId, 'Drafts')).toEqual([]);
    const sentItems = await list(ownId, 'Sent');
    expect(sentItems).toHaveLength(1);
    const raw = await (
      await request(ctx, `/api/v1/mail/messages/${sentItems[0]?.id}/raw`, { headers })
    ).text();
    expect(raw).not.toMatch(/^Bcc:/im);
  });

  it('changes many messages at once and filters the list', async () => {
    const { headers, ownId, ingest, list } = await setup();
    await ingest(message('a', 'Alpha'));
    await ingest(message('b', 'Bravo'));
    await ingest(message('c', 'Charlie'));
    const inbox = await list(ownId, 'INBOX');
    const ids = Object.fromEntries(inbox.map((item) => [item.subject, item.id]));

    const batch = (body: unknown) =>
      request(ctx, '/api/v1/mail/messages/batch', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

    expect((await batch({ ids: [ids.Alpha, ids.Bravo], action: 'read' })).status).toBe(200);
    expect((await batch({ ids: [ids.Charlie], action: 'flag' })).status).toBe(200);
    expect((await list(ownId, 'INBOX', '&filter=unread')).map((item) => item.subject)).toEqual([
      'Charlie',
    ]);
    expect((await list(ownId, 'INBOX', '&filter=flagged')).map((item) => item.subject)).toEqual([
      'Charlie',
    ]);

    expect((await batch({ ids: [ids.Alpha], action: 'move' })).status).toBe(422);
    expect((await batch({ ids: [ids.Alpha], action: 'move', folder: 'Nowhere' })).status).toBe(404);
    expect((await batch({ ids: [ids.Alpha], action: 'move', folder: 'Archive' })).status).toBe(200);
    expect((await batch({ ids: [ids.Bravo, ids.Charlie], action: 'delete' })).status).toBe(200);
    expect(await list(ownId, 'INBOX')).toEqual([]);
    expect((await list(ownId, 'Archive')).map((item) => item.subject)).toEqual(['Alpha']);
    expect(await list(ownId, 'Trash')).toHaveLength(2);

    // Messages of a mailbox the account cannot open are refused.
    expect((await batch({ ids: ['missing-id'], action: 'read' })).status).toBe(404);
  });

  it('renames and deletes custom folders but not system folders', async () => {
    const { headers, ownId, ingest, list } = await setup();
    const folders = `/api/v1/mail/mailboxes/${ownId}/folders`;
    expect(
      (
        await request(ctx, folders, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'Projects/Alpha' }),
        })
      ).status,
    ).toBe(201);
    await ingest(message('p', 'Project mail'));
    const [item] = await list(ownId, 'INBOX');
    await request(ctx, '/api/v1/mail/messages/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: [item?.id], action: 'move', folder: 'Projects/Alpha' }),
    });

    const rename = (from: string, to: string) =>
      request(ctx, folders, { method: 'PATCH', headers, body: JSON.stringify({ from, to }) });
    expect((await rename('INBOX', 'Mail')).status).toBe(422);
    expect((await rename('Projects', 'Projects/Inner')).status).toBe(422);
    expect((await rename('Projects', 'Clients')).status).toBe(200);
    expect((await list(ownId, 'Clients/Alpha')).map((entry) => entry.subject)).toEqual([
      'Project mail',
    ]);
    expect((await rename('Clients/Alpha', 'Clients')).status).toBe(409);

    expect(
      (await request(ctx, `${folders}?name=Trash`, { method: 'DELETE', headers })).status,
    ).toBe(422);
    const removed = await request(ctx, `${folders}?name=Clients`, { method: 'DELETE', headers });
    expect(removed.status).toBe(200);
    expect((await json<{ movedToTrash: number }>(removed)).movedToTrash).toBe(1);
    expect((await list(ownId, 'Trash')).map((entry) => entry.subject)).toEqual(['Project mail']);
    const me = await json<{ items: Array<{ id: string; folders: Array<{ name: string }> }> }>(
      await request(ctx, '/api/v1/mail/me', { headers }),
    );
    const names = me.items.find((entry) => entry.id === ownId)?.folders.map((f) => f.name);
    expect(names).not.toContain('Clients');
    expect(names).not.toContain('Clients/Alpha');
  });

  it('looks up people and groups in the organisation', async () => {
    const { headers } = await setup();
    const found = await json<{ items: Array<{ name: string; address: string; kind: string }> }>(
      await request(ctx, '/api/v1/mail/people?q=info', { headers }),
    );
    expect(found.items).toEqual([
      { name: 'Info desk', address: 'info@example.com', kind: 'shared' },
    ]);
    expect((await request(ctx, '/api/v1/mail/people?q=x')).status).toBe(401);
  });

  it('saves preferences and sends one automatic reply per sender', async () => {
    const { headers, ownId, sharedId, ingest, list } = await setup();
    const defaults = await json<{ readingPane: string; autoReply: { enabled: boolean } }>(
      await request(ctx, '/api/v1/mail/preferences', { headers }),
    );
    expect(defaults.readingPane).toBe('right');
    expect(defaults.autoReply.enabled).toBe(false);

    const save = (body: unknown) =>
      request(ctx, '/api/v1/mail/preferences', {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
    expect((await save({ autoReply: { enabled: true } })).status).toBe(422);
    expect(
      (await save({ autoReply: { enabled: true, startsAt: 2000, endsAt: 1000 } })).status,
    ).toBe(422);
    const saved = await save({
      readingPane: 'bottom',
      signature: 'Owner\nContoso',
      autoReply: { enabled: true, internalMessage: 'Away until Monday.' },
    });
    expect(saved.status).toBe(200);
    expect((await json<{ readingPane: string }>(saved)).readingPane).toBe('bottom');

    const send = (subject: string) =>
      request(ctx, '/api/v1/mail/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mailboxId: sharedId,
          to: ['owner@example.com'],
          subject,
          text: 'Hello',
        }),
      });
    expect((await send('First question')).status).toBe(201);
    expect((await send('Second question')).status).toBe(201);
    const replies = await list(sharedId, 'INBOX');
    expect(replies.map((item) => item.subject)).toEqual(['Automatic reply: First question']);
    expect(await list(ownId, 'INBOX')).toHaveLength(2);

    // Lists and other automatic mail are never answered, and external senders only when asked.
    await ingest(message('l', 'Newsletter', ['List-Id: <news.outside.test>']));
    await ingest(message('x', 'From outside'));
    expect(await list(sharedId, 'INBOX')).toHaveLength(1);

    const audit = await json<{ items: Array<{ action: string }> }>(
      await request(ctx, '/api/v1/audit?limit=50', { headers }),
    );
    expect(audit.items.some((item) => item.action === 'mail.auto_reply.updated')).toBe(true);
  });
});
