import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import selfsigned from 'selfsigned';
import { afterEach, describe, expect, it } from 'vitest';
import { ipAllowed, normaliseAllowlist } from '../src/credentials.js';
import {
  addVerifiedDomain,
  createTestContext,
  destroyTestContext,
  json,
  request,
  setupOwner,
  type TestContext,
  twoTenants,
  userIdOf,
} from './helpers.js';

const PORTS = { imaps: 3993, smtps: 3465, submission: 3587 };
const ENV = { MAIL_LISTEN_PORTS: `${PORTS.imaps},${PORTS.smtps},${PORTS.submission}` };

interface Credential {
  id: string;
  kind: string;
  username: string;
  grants: Array<{ mailboxId: string; read: boolean; write: boolean; send: boolean }>;
  allowedIps: string[];
  enabled: boolean;
  lastUsedAt: number | null;
}

function imap(user: string, pass: string): ImapFlow {
  return new ImapFlow({
    host: '127.0.0.1',
    port: PORTS.imaps,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user, pass },
    logger: false,
  });
}

function smtp(user: string, pass: string) {
  return nodemailer.createTransport({
    host: '127.0.0.1',
    port: PORTS.smtps,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user, pass },
  });
}

describe('IP allowlists', () => {
  it('accepts addresses and CIDR ranges and matches IPv4 on dual-stack sockets', () => {
    const list = normaliseAllowlist([' 203.0.113.7 ', '10.0.0.0/8', '2001:db8::/32', '']);
    expect(list).toEqual(['203.0.113.7', '10.0.0.0/8', '2001:db8::/32']);
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '::ffff:10.20.30.40')).toBe(true);
    expect(ipAllowed(list, '2001:db8:1::5')).toBe(true);
    expect(ipAllowed(list, '198.51.100.1')).toBe(false);
    expect(ipAllowed([], '198.51.100.1')).toBe(true);
    expect(() => normaliseAllowlist(['10.0.0.0/33'])).toThrow();
    expect(() => normaliseAllowlist(['example.com'])).toThrow();
  });
});

describe('service credentials', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.platform.mailServers.stop();
    await destroyTestContext(ctx);
  });

  async function setup() {
    ctx = await createTestContext({ env: ENV });
    const cookie = await setupOwner(ctx);
    const headers = { cookie };
    await addVerifiedDomain(ctx, headers, 'example.com');
    const userId = await userIdOf(ctx, cookie);
    const mailbox = async (body: Record<string, unknown>) =>
      (
        await json<{ id: string }>(
          await request(ctx, '/api/v1/mailboxes', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        )
      ).id;
    const own = await mailbox({ kind: 'user', userId, primaryAddress: 'owner@example.com' });
    const help = await mailbox({ kind: 'shared', primaryAddress: 'help@example.com' });
    const billing = await mailbox({ kind: 'shared', primaryAddress: 'billing@example.com' });
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      keySize: 2048,
    });
    const saved = await request(ctx, '/api/v1/mail/clients', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        enabled: true,
        hostname: 'mail.example.com',
        certMode: 'manual',
        certPem: pems.cert,
        keyPem: pems.private,
      }),
    });
    expect(saved.status).toBe(200);
    const create = (body: Record<string, unknown>) =>
      request(ctx, '/api/v1/mail/credentials', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    const patch = (id: string, body: Record<string, unknown>) =>
      request(ctx, `/api/v1/mail/credentials/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });
    return { headers, own, help, billing, create, patch };
  }

  it('lets a shared mailbox sign in with its own address over IMAP and SMTP', async () => {
    const { own, help, create } = await setup();
    // People sign in with their account; only shared mailboxes get their own login.
    expect((await create({ kind: 'mailbox', mailboxId: own })).status).toBe(422);
    const created = await create({
      kind: 'mailbox',
      mailboxId: help,
      password: 'help-desk-password-1',
    });
    expect(created.status).toBe(201);
    const body = await json<{ credential: Credential; password: string }>(created);
    expect(body.credential.username).toBe('help@example.com');
    expect(body.password).toBe('help-desk-password-1');
    // One login per mailbox.
    expect((await create({ kind: 'mailbox', mailboxId: help })).status).toBe(409);

    const client = imap('help@example.com', 'help-desk-password-1');
    await client.connect();
    try {
      const paths = (await client.list()).map((item) => item.path);
      expect(paths).toContain('INBOX');
      expect(paths.some((path) => path.startsWith('Shared/'))).toBe(false);
      const box = await client.mailboxOpen('INBOX');
      expect(box.readOnly).toBe(false);
    } finally {
      await client.logout();
    }

    const transport = smtp('help@example.com', 'help-desk-password-1');
    await transport.sendMail({
      from: 'help@example.com',
      to: 'owner@example.com',
      subject: 'From the help desk',
      text: 'x',
    });
    await expect(
      transport.sendMail({ from: 'owner@example.com', to: 'help@example.com', text: 'x' }),
    ).rejects.toThrow();
    await expect(imap('help@example.com', 'wrong-password-123').connect()).rejects.toThrow();
  }, 30_000);

  it('limits an application credential to its mailboxes, permissions and addresses', async () => {
    const { help, billing, create, patch, headers } = await setup();
    const created = await json<{ credential: Credential; password: string }>(
      await create({
        kind: 'service',
        name: 'Invoicing app',
        grants: [
          { mailboxId: billing, read: true, write: false, send: false },
          { mailboxId: help, read: false, write: false, send: true },
        ],
      }),
    );
    const { username } = created.credential;
    const { password } = created;
    expect(username).toMatch(/^svc-[0-9a-f]{12}$/);
    expect(password.length).toBeGreaterThanOrEqual(32);

    // Reads billing only, shown at the top level; it cannot change it.
    const client = imap(username, password);
    await client.connect();
    try {
      const paths = (await client.list()).map((item) => item.path);
      expect(paths).toContain('INBOX');
      expect(paths.some((path) => path.includes('help@'))).toBe(false);
      const box = await client.mailboxOpen('INBOX');
      expect(box.readOnly).toBe(true);
      await client.mailboxClose();
      await expect(client.append('INBOX', 'Subject: x\r\n\r\nx')).rejects.toThrow();
    } finally {
      await client.logout();
    }

    // Sends as help, not as billing.
    const transport = smtp(username, password);
    await transport.sendMail({ from: 'help@example.com', to: 'owner@example.com', text: 'x' });
    await expect(
      transport.sendMail({ from: 'billing@example.com', to: 'owner@example.com', text: 'x' }),
    ).rejects.toThrow();

    const accounts = ctx.platform.mailServers.accounts;
    expect(await accounts.verify(username, password, '127.0.0.1')).toMatchObject({
      grants: expect.any(Array),
    });
    // IP allowlist.
    expect((await patch(created.credential.id, { allowedIps: ['10.0.0.0/8'] })).status).toBe(200);
    expect(await accounts.verify(username, password, '127.0.0.1')).toBeNull();
    expect(await accounts.verify(username, password, '::ffff:10.1.2.3')).not.toBeNull();
    expect((await patch(created.credential.id, { allowedIps: ['nope'] })).status).toBe(422);
    // Disable, then rotate.
    expect((await patch(created.credential.id, { enabled: false })).status).toBe(200);
    expect(await accounts.verify(username, password, '10.1.2.3')).toBeNull();
    await patch(created.credential.id, { enabled: true });
    const rotated = await json<{ password: string }>(
      await request(ctx, `/api/v1/mail/credentials/${created.credential.id}/rotate`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
    );
    expect(await accounts.verify(username, password, '10.1.2.3')).toBeNull();
    expect(await accounts.verify(username, rotated.password, '10.1.2.3')).not.toBeNull();

    const list = await json<{ items: Credential[] }>(
      await request(ctx, '/api/v1/mail/credentials', { headers }),
    );
    expect(list.items.find((item) => item.id === created.credential.id)?.lastUsedAt).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain('secret');

    const audit = await json<{ items: Array<{ action: string }> }>(
      await request(ctx, '/api/v1/audit?actionPrefix=mail.credential', { headers }),
    );
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'mail.credential.created',
        'mail.credential.updated',
        'mail.credential.rotated',
      ]),
    );

    expect(
      (
        await request(ctx, `/api/v1/mail/credentials/${created.credential.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(200);
    expect(await accounts.verify(username, rotated.password, '10.1.2.3')).toBeNull();
  }, 30_000);
});

describe('service credentials between tenants', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await destroyTestContext(ctx);
  });

  it('keeps credentials and grants inside their tenant', async () => {
    ctx = await createTestContext();
    const { alice, bob } = await twoTenants(ctx);
    await addVerifiedDomain(ctx, { cookie: alice }, 'contoso.test');
    const shared = await json<{ id: string }>(
      await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ kind: 'shared', primaryAddress: 'info@contoso.test' }),
      }),
    );
    const created = await json<{ credential: Credential }>(
      await request(ctx, '/api/v1/mail/credentials', {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ kind: 'mailbox', mailboxId: shared.id }),
      }),
    );
    const bobList = await json<{ items: Credential[] }>(
      await request(ctx, '/api/v1/mail/credentials', { headers: { cookie: bob } }),
    );
    expect(bobList.items).toEqual([]);
    const bobPatch = await request(ctx, `/api/v1/mail/credentials/${created.credential.id}`, {
      method: 'PATCH',
      headers: { cookie: bob },
      body: JSON.stringify({ enabled: false }),
    });
    expect(bobPatch.status).toBe(404);
    // Bob cannot grant a mailbox of another tenant to his own credential.
    const stolen = await request(ctx, '/api/v1/mail/credentials', {
      method: 'POST',
      headers: { cookie: bob },
      body: JSON.stringify({
        kind: 'service',
        grants: [{ mailboxId: shared.id, read: true, write: true, send: true }],
      }),
    });
    expect(stolen.status).toBe(404);
  });
});
