import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import selfsigned from 'selfsigned';
import { afterEach, describe, expect, it } from 'vitest';
import { MailServers } from '../src/mailserver/index.js';
import {
  createTestContext,
  destroyTestContext,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

const PORTS = { imaps: 2993, smtps: 2465, submission: 2587 };
const ENV = { MAIL_LISTEN_PORTS: `${PORTS.imaps},${PORTS.smtps},${PORTS.submission}` };

async function certificate(cn: string) {
  const pems = await selfsigned.generate([{ name: 'commonName', value: cn }], { keySize: 2048 });
  return { cert: pems.cert, key: pems.private };
}

/** Reads from a socket until `pattern` appears. */
function readUntil(socket: Socket | TLSSocket, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${pattern}; got ${data}`)),
      5000,
    );
    const onData = (chunk: Buffer) => {
      data += chunk.toString();
      if (pattern.test(data)) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(data);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function tlsHandshake(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: 'mail.example.com',
      rejectUnauthorized: false,
    });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function imapGreeting(): Promise<{ greeting: string; cn: string }> {
  const socket = await tlsHandshake(PORTS.imaps);
  const greeting = await readUntil(socket, /\r\n/);
  const cn = String(socket.getPeerCertificate().subject.CN);
  socket.destroy();
  return { greeting, cn };
}

async function smtpsBanner(): Promise<string> {
  const socket = await tlsHandshake(PORTS.smtps);
  const banner = await readUntil(socket, /^220 /m);
  socket.destroy();
  return banner;
}

/** EHLO, STARTTLS and a completed TLS handshake on the submission port. */
async function starttls(): Promise<{ ehlo: string; cn: string }> {
  const plain = netConnect({ host: '127.0.0.1', port: PORTS.submission });
  await readUntil(plain, /^220 /m);
  plain.write('EHLO test.local\r\n');
  const ehlo = await readUntil(plain, /^250 /m);
  plain.write('STARTTLS\r\n');
  await readUntil(plain, /^220 /m);
  const secure = await new Promise<TLSSocket>((resolve, reject) => {
    const socket = tlsConnect({
      socket: plain,
      servername: 'mail.example.com',
      rejectUnauthorized: false,
    });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
  const cn = String(secure.getPeerCertificate().subject.CN);
  secure.destroy();
  return { ehlo, cn };
}

describe('mail app listeners', () => {
  let ctx: TestContext;
  let extra: MailServers | null = null;

  afterEach(async () => {
    await extra?.stop();
    extra = null;
    if (ctx) {
      await ctx.platform.mailServers.stop();
      await destroyTestContext(ctx);
    }
  });

  async function configure(body: Record<string, unknown>) {
    const headers = { cookie: await setupOwner(ctx) };
    const response = await request(ctx, '/api/v1/mail/clients', {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    return { headers, response };
  }

  it('starts all three listeners, restores them on restart and serves TLS on each', async () => {
    ctx = await createTestContext(ENV);
    const pem = await certificate('mail.example.com');
    const { response } = await configure({
      enabled: true,
      hostname: 'mail.example.com',
      certMode: 'manual',
      certPem: pem.cert,
      keyPem: pem.key,
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      running: boolean;
      listeners: Array<{ name: string; port: number; state: string; accepting: boolean }>;
    };
    expect(view.running).toBe(true);
    expect(
      view.listeners.map((item) => [item.name, item.port, item.state, item.accepting]),
    ).toEqual([
      ['imaps', PORTS.imaps, 'listening', true],
      ['smtps', PORTS.smtps, 'listening', true],
      ['submission', PORTS.submission, 'listening', true],
    ]);

    // Simulate a container restart: a fresh manager restores from persisted settings.
    await ctx.platform.mailServers.stop();
    extra = new MailServers(ctx.platform);
    await extra.start();
    const restored = await extra.listeners();
    expect(restored.every((item) => item.state === 'listening' && item.accepting)).toBe(true);

    const imap = await imapGreeting();
    expect(imap.greeting).toMatch(/^\* OK .*ASPECTenant IMAP ready/);
    expect(imap.cn).toBe('mail.example.com');
    expect(await smtpsBanner()).toMatch(/^220 /m);
    const sub = await starttls();
    expect(sub.ehlo).toMatch(/STARTTLS/);
    expect(sub.cn).toBe('mail.example.com');
    const health = await extra.checkHealth();
    expect(health.ok).toBe(true);
  }, 30_000);

  it('reports why nothing is listening when no certificate is configured', async () => {
    ctx = await createTestContext(ENV);
    const { response } = await configure({
      enabled: true,
      hostname: 'mail.example.com',
      certMode: 'acme',
    });
    const view = (await response.json()) as {
      running: boolean;
      problem: string;
      listeners: Array<{ state: string; accepting: boolean; error: string }>;
    };
    expect(view.running).toBe(false);
    expect(view.problem).toMatch(/No certificate configured/);
    expect(view.listeners.every((item) => item.state === 'failed' && !item.accepting)).toBe(true);
    expect((await ctx.platform.mailServers.checkHealth()).ok).toBe(false);
  });

  it('loads the certificate from the data volume', async () => {
    ctx = await createTestContext(ENV);
    const pem = await certificate('mail.example.com');
    mkdirSync(join(ctx.platform.config.dataDir, 'mail-tls'), { recursive: true });
    writeFileSync(join(ctx.platform.config.dataDir, 'mail-tls/fullchain.pem'), pem.cert);
    writeFileSync(join(ctx.platform.config.dataDir, 'mail-tls/privkey.pem'), pem.key);
    const { response } = await configure({
      enabled: true,
      hostname: 'mail.example.com',
      certMode: 'manual',
    });
    const view = (await response.json()) as { running: boolean; certificateSource: string };
    expect(view.running).toBe(true);
    expect(view.certificateSource).toBe('data-volume');
    expect((await imapGreeting()).cn).toBe('mail.example.com');
  });

  it('swaps a replaced certificate into the running listeners', async () => {
    ctx = await createTestContext(ENV);
    const first = await certificate('old.example.com');
    const { headers } = await configure({
      enabled: true,
      hostname: 'mail.example.com',
      certMode: 'manual',
      certPem: first.cert,
      keyPem: first.key,
    });
    expect((await imapGreeting()).cn).toBe('old.example.com');
    const second = await certificate('mail.example.com');
    const replaced = await request(ctx, '/api/v1/mail/clients', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        enabled: true,
        hostname: 'mail.example.com',
        certMode: 'manual',
        certPem: second.cert,
        keyPem: second.key,
      }),
    });
    expect(((await replaced.json()) as { running: boolean }).running).toBe(true);
    expect((await imapGreeting()).cn).toBe('mail.example.com');
    expect((await starttls()).cn).toBe('mail.example.com');
  });

  it('reports a port conflict per listener and recovers on retry', async () => {
    ctx = await createTestContext(ENV);
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(PORTS.submission, '0.0.0.0', () => resolve()),
    );
    const pem = await certificate('mail.example.com');
    const { response } = await configure({
      enabled: true,
      hostname: 'mail.example.com',
      certMode: 'manual',
      certPem: pem.cert,
      keyPem: pem.key,
    });
    const view = (await response.json()) as {
      running: boolean;
      listeners: Array<{ name: string; state: string; code: string | null }>;
    };
    expect(view.running).toBe(false);
    expect(view.listeners.find((item) => item.name === 'submission')).toMatchObject({
      state: 'failed',
      code: 'EADDRINUSE',
    });
    expect(view.listeners.find((item) => item.name === 'imaps')?.state).toBe('listening');
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await ctx.platform.mailServers.reconcile('retry');
    const after = await ctx.platform.mailServers.listeners();
    expect(after.every((item) => item.state === 'listening' && item.accepting)).toBe(true);
  });
});
