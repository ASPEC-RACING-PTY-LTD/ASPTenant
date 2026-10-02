import type { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  createSecureContext,
  createServer as createTlsServer,
  type Server as TlsServer,
} from 'node:tls';
import { createScryptHasher, normalizeEmail } from '@aspec/auth';
import { createSqlAuthStore } from '@aspec/auth/sql';
import { UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import acme from 'acme-client';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import { parseHeaders } from '../imap/mime.js';
import { ImapSession, type MailAuthenticator } from '../imap/session.js';
import { SettingsStore } from '../mail/store.js';
import type { Platform } from '../platform.js';

const KEY = 'mail-clients';
export const CLIENT_PORTS = { imaps: 1993, smtps: 1465, submission: 1587 } as const;
const PUBLIC_PORTS: { imaps: number; smtps: number; submission: number } = {
  imaps: 993,
  smtps: 465,
  submission: 587,
};
const MAX_MESSAGE = 30 * 1024 * 1024;

export type CertMode = 'acme' | 'manual';

export const LISTENER_NAMES = ['imaps', 'smtps', 'submission'] as const;
export type ListenerName = (typeof LISTENER_NAMES)[number];

export interface ListenerStatus {
  name: ListenerName;
  protocol: string;
  port: number;
  state: 'stopped' | 'listening' | 'failed';
  /** True only when a TCP connection to the port succeeded just now. */
  accepting: boolean;
  error: string | null;
  code: string | null;
  since: number | null;
}

const PROTOCOLS: Record<ListenerName, string> = {
  imaps: 'IMAP over implicit TLS',
  smtps: 'SMTP submission over implicit TLS',
  submission: 'SMTP submission with STARTTLS',
};

/** Certificate files an operator can place in the data volume instead of using the panel. */
export const TLS_FILES = { cert: 'mail-tls/fullchain.pem', key: 'mail-tls/privkey.pem' } as const;

class MailAppsProblem extends Error {}

interface StoredClientSettings {
  enabled: boolean;
  hostname: string;
  certMode: CertMode;
  acmeEmail: string | null;
  cloudflareDnsToken: string | null;
  certPem: string | null;
  keyPem: string | null;
  certExpiresAt: number | null;
  lastError: string | null;
}

export interface ClientSettingsView {
  enabled: boolean;
  hostname: string;
  certMode: CertMode;
  acmeEmail: string | null;
  hasDnsToken: boolean;
  hasCertificate: boolean;
  certExpiresAt: number | null;
  lastError: string | null;
  /** True only when all three listeners are bound and accepting connections. */
  running: boolean;
  /** Why the listeners are not running, when they are not. */
  problem: string | null;
  certificateSource: 'panel' | 'data-volume' | null;
  cloudflareConnected: boolean;
  listeners: ListenerStatus[];
  ports: typeof PUBLIC_PORTS;
}

const DEFAULTS: StoredClientSettings = {
  enabled: false,
  hostname: '',
  certMode: 'acme',
  acmeEmail: null,
  cloudflareDnsToken: null,
  certPem: null,
  keyPem: null,
  certExpiresAt: null,
  lastError: null,
};

/** Password check for IMAP and SMTP, with a per-IP failure limit. */
export class MailAccounts implements MailAuthenticator {
  private readonly store;
  private readonly hasher = createScryptHasher();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private dummy: Promise<string> | null = null;

  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = createSqlAuthStore(platform.db);
  }

  async verify(email: string, password: string, ip: string): Promise<string | null> {
    const now = Date.now();
    const login = (normalizeEmail(email) ?? email.trim().toLowerCase()).slice(0, 320);
    // Lock out per address and account: services such as Outlook mobile log in from shared IPs.
    const key = `${ip}|${login}`;
    const failure = this.failures.get(key);
    const fail = (reason: string) => {
      const count = failure && failure.until > now ? failure.count + 1 : 1;
      this.failures.set(key, { count, until: now + 15 * 60 * 1000 });
      this.platform.logger.warn(
        { ip, email: login, reason },
        `mail client login failed: ${reason}`,
      );
      return null;
    };
    if (failure && failure.until > now && failure.count >= 10) {
      this.platform.logger.warn(
        { ip, email: login },
        'mail client login blocked: too many failures, wait 15 minutes',
      );
      return null;
    }
    if (!login || !password) return fail('missing username or password');
    const account = await this.store.getAccountByEmail(login);
    if (!account?.passwordHash) {
      this.dummy ??= this.hasher.hash('dummy-password-for-timing');
      await this.hasher.verify(await this.dummy, password);
      return fail('no ASPECTenant account with this email (use the sign-in email, not an alias)');
    }
    if (!(await this.hasher.verify(account.passwordHash, password))) return fail('wrong password');
    if (account.disabledAt) return fail('account is disabled');
    if (account.lockedUntil && account.lockedUntil > now) return fail('account is locked');
    const user = await this.platform.users.findUser(account.id);
    if (!user || user.status !== 'active') return fail('user is suspended');
    const mailboxes = await this.platform.directory.listAccessibleMailboxes(account.id);
    if (mailboxes.length === 0) return fail('account has no mailbox; create one under Mail');
    this.failures.delete(key);
    this.platform.logger.info({ ip, email: login }, 'mail client login ok');
    return account.id;
  }
}

async function cloudflare(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    success: boolean;
    errors?: { message: string }[];
    result: unknown;
  };
  if (!body.success) {
    throw new Error(
      `Cloudflare API: ${body.errors?.map((e) => e.message).join(', ') || response.status}`,
    );
  }
  return body.result;
}

async function findZone(token: string, hostname: string): Promise<string> {
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const name = labels.slice(i).join('.');
    const zones = (await cloudflare(token, `/zones?name=${encodeURIComponent(name)}`)) as {
      id: string;
    }[];
    if (zones[0]) return zones[0].id;
  }
  throw new Error(`No Cloudflare zone found for ${hostname}. Check the token has Zone:Read.`);
}

export class MailServers {
  readonly accounts: MailAccounts;
  private readonly settings: SettingsStore;
  private readonly servers: Record<ListenerName, TlsServer | SMTPServer | null> = {
    imaps: null,
    smtps: null,
    submission: null,
  };
  private readonly status: Record<ListenerName, ListenerStatus>;
  private problem: string | null = 'Mail apps have not been started yet.';
  private certificateSource: 'panel' | 'data-volume' | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly sockets = new Set<Socket>();

  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.accounts = new MailAccounts(platform);
    this.settings = new SettingsStore(platform.db);
    const ports = this.listenPorts();
    this.status = Object.fromEntries(
      LISTENER_NAMES.map((name) => [
        name,
        {
          name,
          protocol: PROTOCOLS[name],
          port: ports[name],
          state: 'stopped',
          accepting: false,
          error: null,
          code: null,
          since: null,
        } satisfies ListenerStatus,
      ]),
    ) as Record<ListenerName, ListenerStatus>;
  }

  /** Container ports the listeners bind (the host maps 993/465/587 onto them). */
  private listenPorts(): Record<ListenerName, number> {
    const [imaps, smtps, submission] = this.platform.config.mailListenPorts
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10));
    return {
      imaps: imaps || CLIENT_PORTS.imaps,
      smtps: smtps || CLIENT_PORTS.smtps,
      submission: submission || CLIENT_PORTS.submission,
    };
  }

  private async tenantId(): Promise<string> {
    return (await this.platform.orgs.getDefaultOrg()).id;
  }

  private async load(): Promise<StoredClientSettings> {
    return {
      ...DEFAULTS,
      ...((await this.settings.get<StoredClientSettings>(await this.tenantId(), KEY)) ?? {}),
    };
  }

  private async save(next: StoredClientSettings): Promise<void> {
    await this.settings.set(await this.tenantId(), KEY, next);
  }

  private publicPorts(): typeof PUBLIC_PORTS {
    const [imaps, smtps, submission] = this.platform.config.mailPublicPorts
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10));
    return {
      imaps: imaps || PUBLIC_PORTS.imaps,
      smtps: smtps || PUBLIC_PORTS.smtps,
      submission: submission || PUBLIC_PORTS.submission,
    };
  }

  async view(): Promise<ClientSettingsView> {
    const stored = await this.load();
    const listeners = await this.listeners();
    return {
      enabled: stored.enabled,
      hostname: stored.hostname,
      certMode: stored.certMode,
      acmeEmail: stored.acmeEmail,
      hasDnsToken: Boolean(stored.cloudflareDnsToken),
      hasCertificate: Boolean(stored.certPem && stored.keyPem),
      certExpiresAt: stored.certExpiresAt,
      lastError: stored.lastError,
      running: listeners.every((item) => item.accepting),
      problem: this.problem,
      certificateSource: this.certificateSource,
      cloudflareConnected: Boolean(await this.platform.domainSetup.cloudflareToken()),
      listeners,
      ports: this.publicPorts(),
    };
  }

  async update(
    input: {
      enabled: boolean;
      hostname: string;
      certMode: CertMode;
      acmeEmail?: string | null;
      cloudflareDnsToken?: string;
      certPem?: string;
      keyPem?: string;
    },
    actor: Actor,
  ): Promise<ClientSettingsView> {
    const stored = await this.load();
    const hostname = input.hostname.trim().toLowerCase();
    if (input.enabled && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) {
      throw new UnprocessableError(
        'Enter the hostname clients connect to, for example mail.example.com.',
      );
    }
    const next: StoredClientSettings = {
      ...stored,
      enabled: input.enabled,
      hostname,
      certMode: input.certMode,
      acmeEmail: input.acmeEmail?.trim() || null,
    };
    if (input.cloudflareDnsToken?.trim()) {
      next.cloudflareDnsToken = this.platform.secrets.encrypt(input.cloudflareDnsToken.trim());
    }
    if (input.certMode === 'manual' && input.certPem?.trim() && input.keyPem?.trim()) {
      const info = acme.crypto.readCertificateInfo(input.certPem.trim());
      next.certPem = input.certPem.trim();
      next.keyPem = this.platform.secrets.encrypt(input.keyPem.trim());
      next.certExpiresAt = info.notAfter.getTime();
      next.lastError = null;
    }
    await this.save(next);
    await this.platform.audit.record({
      action: 'mail.clients.updated',
      outcome: 'success',
      category: 'admin',
      actor,
      resource: { type: 'mail-clients', id: KEY },
      changes: { after: { enabled: next.enabled, hostname, certMode: next.certMode } },
    });
    await this.reconcile('settings-changed');
    return this.view();
  }

  /** Requests a Let's Encrypt certificate with a Cloudflare DNS-01 challenge. */
  async issueCertificate(): Promise<ClientSettingsView> {
    const stored = await this.load();
    if (!stored.hostname) throw new UnprocessableError('Save a hostname first.');
    const token = stored.cloudflareDnsToken
      ? this.platform.secrets.decrypt(stored.cloudflareDnsToken)
      : await this.platform.domainSetup.cloudflareToken();
    if (!token) {
      throw new UnprocessableError(
        'Connect Cloudflare on the Domains page, or save a token here with Zone:Read and DNS:Edit.',
      );
    }
    try {
      const zone = await findZone(token, stored.hostname);
      const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey: await acme.crypto.createPrivateKey(),
      });
      const [key, csr] = await acme.crypto.createCsr({ commonName: stored.hostname });
      const records = new Map<string, string>();
      const cert = await client.auto({
        csr,
        ...(stored.acmeEmail ? { email: stored.acmeEmail } : {}),
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        skipChallengeVerification: true,
        challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
          const result = (await cloudflare(token, `/zones/${zone}/dns_records`, {
            method: 'POST',
            body: JSON.stringify({
              type: 'TXT',
              name: `_acme-challenge.${authz.identifier.value}`,
              content: keyAuthorization,
              ttl: 60,
            }),
          })) as { id: string };
          records.set(keyAuthorization, result.id);
          await new Promise((resolve) => setTimeout(resolve, 20_000));
        },
        challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
          const id = records.get(keyAuthorization);
          if (id) await cloudflare(token, `/zones/${zone}/dns_records/${id}`, { method: 'DELETE' });
        },
      });
      const info = acme.crypto.readCertificateInfo(cert);
      await this.save({
        ...(await this.load()),
        certPem: cert,
        keyPem: this.platform.secrets.encrypt(key.toString()),
        certExpiresAt: info.notAfter.getTime(),
        lastError: null,
      });
      this.platform.logger.info({ hostname: stored.hostname }, 'mail client certificate issued');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.save({ ...(await this.load()), lastError: message });
      throw new UnprocessableError(`Certificate request failed: ${message}`);
    }
    await this.reconcile('settings-changed');
    return this.view();
  }

  /** Restores the listeners from persisted settings and keeps retrying while any is down. */
  async start(): Promise<void> {
    await this.reconcile('startup');
    this.renewTimer = setInterval(() => void this.renewIfDue(), 12 * 60 * 60 * 1000);
    this.renewTimer.unref();
    this.retryTimer = setInterval(() => {
      const down = LISTENER_NAMES.some((name) => this.status[name].state !== 'listening');
      if (down) void this.reconcile('retry');
    }, 60_000);
    this.retryTimer.unref();
  }

  private async renewIfDue(): Promise<void> {
    const stored = await this.load();
    if (!stored.enabled || stored.certMode !== 'acme' || !stored.certExpiresAt) return;
    if (stored.certExpiresAt - Date.now() > 30 * 86_400_000) return;
    await this.issueCertificate().catch((error: unknown) => {
      this.platform.logger.error(
        { event: 'mail_apps_certificate_renewal_failed', err: error },
        'mail apps certificate renewal failed; the current certificate stays in use',
      );
    });
  }

  /** Loads and validates the certificate: panel settings first, then files in the data volume. */
  private async loadTls(stored: StoredClientSettings): Promise<{ key: string; cert: string }> {
    let key: string;
    let cert: string;
    if (stored.certPem && stored.keyPem) {
      try {
        key = this.platform.secrets.decrypt(stored.keyPem);
      } catch {
        throw new MailAppsProblem(
          'The stored private key cannot be decrypted (SECRET_KEY or AUDIT_HMAC_KEY changed). Issue or upload the certificate again.',
        );
      }
      cert = stored.certPem;
      this.certificateSource = 'panel';
    } else {
      const certPath = join(this.platform.config.dataDir, TLS_FILES.cert);
      const keyPath = join(this.platform.config.dataDir, TLS_FILES.key);
      try {
        [cert, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
      } catch {
        throw new MailAppsProblem(
          `No certificate configured. Use "Get certificate" on Mail apps, upload a PEM certificate and key, or place ${certPath} and ${keyPath} in the data volume.`,
        );
      }
      this.certificateSource = 'data-volume';
    }
    try {
      createSecureContext({ key, cert });
    } catch (error) {
      throw new MailAppsProblem(
        `The certificate or private key is invalid or they do not match: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const info = acme.crypto.readCertificateInfo(cert);
      if (info.notAfter.getTime() < Date.now()) {
        this.platform.logger.error(
          { event: 'mail_apps_certificate_expired', notAfter: info.notAfter.toISOString() },
          'mail apps certificate has expired; mail apps will reject it until it is renewed',
        );
      }
    } catch {
      // Expiry is informational; createSecureContext already validated the PEM.
    }
    return { key, cert };
  }

  /** Brings the listeners in line with settings. Serialised so concurrent calls cannot race. */
  reconcile(reason: string): Promise<void> {
    const run = this.queue.then(() => this.reconcileNow(reason));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async reconcileNow(reason: string): Promise<void> {
    const stored = await this.load();
    if (!stored.enabled) {
      await this.stopAll();
      this.problem = 'Mail apps are disabled.';
      this.platform.logger.info(
        { event: 'mail_apps_disabled', reason },
        'mail apps disabled; IMAP and SMTP listeners are not running',
      );
      return;
    }
    let tls: { key: string; cert: string };
    try {
      if (!stored.hostname) throw new MailAppsProblem('No mail apps hostname is configured.');
      tls = await this.loadTls(stored);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stopAll();
      this.problem = message;
      for (const name of LISTENER_NAMES) this.mark(name, 'failed', message, 'CONFIG');
      this.platform.logger.error(
        { event: 'mail_apps_start_failed', reason, problem: message, listeners: this.snapshot() },
        `mail apps cannot start: ${message}`,
      );
      return;
    }
    const ports = this.listenPorts();
    const host = this.platform.config.mailListenHost;
    for (const name of LISTENER_NAMES) {
      const server = this.servers[name];
      if (server && this.status[name].state === 'listening' && this.isListening(server)) {
        try {
          if (server instanceof SMTPServer) server.updateSecureContext(tls);
          else server.setSecureContext(tls);
          continue;
        } catch (error) {
          this.platform.logger.error(
            { event: 'mail_apps_tls_update_failed', listener: name, err: error },
            `could not apply the new certificate to ${name}; restarting it`,
          );
          await this.closeOne(name);
        }
      } else if (server) {
        await this.closeOne(name);
      }
      const created = this.create(name, tls, stored.hostname);
      const events = created as unknown as EventEmitter;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          events.once('error', onError);
          created.listen(ports[name], host, () => {
            events.off('error', onError);
            resolve();
          });
        });
        events.on('error', (error: Error) => {
          // smtp-server also emits per-connection errors (a client dropping mid-handshake).
          // Only a server that stopped listening is a listener failure.
          if (this.isListening(created)) return;
          this.mark(name, 'failed', error.message, (error as NodeJS.ErrnoException).code ?? null);
          this.platform.logger.error(
            { event: 'mail_apps_listener_error', listener: name, port: ports[name], err: error },
            `${name} listener error`,
          );
        });
        this.servers[name] = created;
        this.mark(name, 'listening', null, null);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        this.mark(name, 'failed', err.message, err.code ?? null);
        this.platform.logger.error(
          {
            event: 'mail_apps_listener_failed',
            listener: name,
            protocol: PROTOCOLS[name],
            host,
            port: ports[name],
            code: err.code ?? null,
            err: error,
          },
          `${name} could not listen on ${host}:${ports[name]}: ${err.message}`,
        );
        await new Promise<void>((resolve) => created.close(() => resolve()));
      }
    }
    const failed = LISTENER_NAMES.filter((name) => this.status[name].state !== 'listening');
    this.problem = failed.length
      ? `Not listening: ${failed.map((name) => `${name} (${this.status[name].error})`).join(', ')}`
      : null;
    const log = failed.length ? this.platform.logger.error : this.platform.logger.info;
    log.call(
      this.platform.logger,
      {
        event: failed.length ? 'mail_apps_partially_running' : 'mail_apps_running',
        reason,
        hostname: stored.hostname,
        certificate: this.certificateSource,
        listeners: this.snapshot(),
      },
      failed.length
        ? `mail apps listeners failed: ${failed.join(', ')}`
        : 'IMAP and SMTP listeners running',
    );
  }

  private create(name: ListenerName, tls: { key: string; cert: string }, hostname: string) {
    if (name === 'imaps') {
      const server = createTlsServer(tls, (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        new ImapSession(socket, this.platform, this.accounts, socket.remoteAddress ?? 'unknown');
      });
      server.on('tlsClientError', () => undefined);
      return server;
    }
    return this.smtp(name === 'smtps', tls, hostname);
  }

  private isListening(server: TlsServer | SMTPServer): boolean {
    return server instanceof SMTPServer ? server.server.listening : server.listening;
  }

  private mark(
    name: ListenerName,
    state: ListenerStatus['state'],
    error: string | null,
    code: string | null,
  ) {
    const ports = this.listenPorts();
    this.status[name] = {
      ...this.status[name],
      port: ports[name],
      state,
      error,
      code,
      since: Date.now(),
    };
  }

  private snapshot() {
    return LISTENER_NAMES.map((name) => ({
      listener: name,
      port: this.status[name].port,
      state: this.status[name].state,
      ...(this.status[name].error
        ? { error: this.status[name].error, code: this.status[name].code }
        : {}),
    }));
  }

  /** Live status: each listener's bind state plus a real TCP connection test. */
  async listeners(): Promise<ListenerStatus[]> {
    const host =
      this.platform.config.mailListenHost === '0.0.0.0'
        ? '127.0.0.1'
        : this.platform.config.mailListenHost;
    return Promise.all(
      LISTENER_NAMES.map(async (name) => {
        const server = this.servers[name];
        const bound =
          Boolean(server && this.isListening(server)) && this.status[name].state === 'listening';
        const accepting = bound ? await probe(host, this.status[name].port) : false;
        return { ...this.status[name], accepting };
      }),
    );
  }

  /** Health check: ok when disabled, or when every listener accepts connections. */
  async checkHealth(): Promise<{ ok: boolean; details: Record<string, unknown> }> {
    const stored = await this.load();
    const listeners = await this.listeners();
    const ok = !stored.enabled || listeners.every((item) => item.accepting);
    return {
      ok,
      details: {
        enabled: stored.enabled,
        problem: this.problem,
        listeners: Object.fromEntries(
          listeners.map((item) => [
            item.name,
            { port: item.port, state: item.state, accepting: item.accepting, error: item.error },
          ]),
        ),
      },
    };
  }

  private async closeOne(name: ListenerName): Promise<void> {
    const server = this.servers[name];
    this.servers[name] = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async stopAll(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(LISTENER_NAMES.map((name) => this.closeOne(name)));
    for (const name of LISTENER_NAMES) {
      if (this.status[name].state === 'listening') this.mark(name, 'stopped', null, null);
    }
  }

  async stop(): Promise<void> {
    await this.queue;
    await this.stopAll();
  }

  shutdown(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    void this.stop();
  }

  private smtp(secure: boolean, tls: { key: string; cert: string }, hostname: string): SMTPServer {
    const mail = this.platform.mail;
    const server = new SMTPServer({
      secure,
      ...tls,
      name: hostname,
      banner: 'ASPECTenant submission',
      size: MAX_MESSAGE,
      authMethods: ['PLAIN', 'LOGIN'],
      allowInsecureAuth: false,
      logger: false,
      closeTimeout: 2000,
      onAuth: (auth, session, callback) => {
        void this.accounts
          .verify(auth.username ?? '', auth.password ?? '', session.remoteAddress)
          .then((account) =>
            account
              ? callback(null, { user: account })
              : callback(new Error('Invalid credentials')),
          )
          .catch((error: Error) => callback(error));
      },
      onMailFrom: (address, session, callback) => {
        void this.allowed(session, address.address)
          .then((ok) => callback(ok ? undefined : rejection('Sender address not allowed', 553)))
          .catch((error: Error) => callback(error));
      },
      onData: (stream, session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          void (async () => {
            if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
              throw rejection('Message too large', 552);
            }
            const raw = Buffer.concat(chunks);
            const headerEnd = raw.indexOf('\r\n\r\n');
            const headers = parseHeaders(
              raw.subarray(0, headerEnd === -1 ? raw.length : headerEnd),
            );
            const fromHeader = headers.get('from')?.[0] ?? '';
            const from = (addressparser(fromHeader, { flatten: true }) as { address: string }[])[0];
            if (!from || !(await this.allowed(session, from.address))) {
              throw rejection('From address not allowed for this account', 553);
            }
            const envelopeFrom = session.envelope.mailFrom
              ? session.envelope.mailFrom.address
              : from.address;
            await mail.dispatch(
              raw,
              envelopeFrom,
              session.envelope.rcptTo.map((item) => item.address),
            );
          })()
            .then(() => callback())
            .catch((error: Error & { responseCode?: number }) => {
              if (!error.responseCode) error.responseCode = 554;
              callback(error);
            });
        });
      },
    });
    // Per-connection errors (clients and health probes hanging up); listener failures are
    // handled in reconcileNow.
    server.on('error', (error) =>
      this.platform.logger.debug({ err: error }, 'smtp submission connection error'),
    );
    return server;
  }

  private async allowed(session: SMTPServerSession, address: string): Promise<boolean> {
    const account = session.user as string | undefined;
    if (!account) return false;
    return (await this.platform.mail.sendableAddresses(account)).has(address.trim().toLowerCase());
  }
}

/** True when a TCP connection to host:port succeeds within a second. */
function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function rejection(message: string, code: number): Error & { responseCode: number } {
  return Object.assign(new Error(message), { responseCode: code });
}
