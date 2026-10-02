import type { Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
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
  running: boolean;
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
  private imap: TlsServer | null = null;
  private smtps: SMTPServer | null = null;
  private submission: SMTPServer | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private readonly sockets = new Set<Socket>();

  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.accounts = new MailAccounts(platform);
    this.settings = new SettingsStore(platform.db);
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
    return {
      enabled: stored.enabled,
      hostname: stored.hostname,
      certMode: stored.certMode,
      acmeEmail: stored.acmeEmail,
      hasDnsToken: Boolean(stored.cloudflareDnsToken),
      hasCertificate: Boolean(stored.certPem && stored.keyPem),
      certExpiresAt: stored.certExpiresAt,
      lastError: stored.lastError,
      running: this.imap !== null,
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
    await this.apply();
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
    await this.apply();
    return this.view();
  }

  async start(): Promise<void> {
    await this.apply().catch((error: unknown) => {
      this.platform.logger.error({ err: error }, 'mail client servers failed to start');
    });
    this.renewTimer = setInterval(() => void this.renewIfDue(), 12 * 60 * 60 * 1000);
    this.renewTimer.unref();
  }

  private async renewIfDue(): Promise<void> {
    const stored = await this.load();
    if (!stored.enabled || stored.certMode !== 'acme' || !stored.certExpiresAt) return;
    if (stored.certExpiresAt - Date.now() > 30 * 86_400_000) return;
    await this.issueCertificate().catch((error: unknown) => {
      this.platform.logger.error({ err: error }, 'mail client certificate renewal failed');
    });
  }

  private async apply(): Promise<void> {
    const stored = await this.load();
    if (!stored.enabled || !stored.certPem || !stored.keyPem) {
      await this.stop();
      return;
    }
    const tls = { key: this.platform.secrets.decrypt(stored.keyPem), cert: stored.certPem };
    if (this.imap) {
      this.imap.setSecureContext(tls);
      this.smtps?.updateSecureContext(tls);
      this.submission?.updateSecureContext(tls);
      return;
    }
    this.imap = createTlsServer(tls, (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      new ImapSession(socket, this.platform, this.accounts, socket.remoteAddress ?? 'unknown');
    });
    this.imap.on('tlsClientError', () => undefined);
    this.imap.listen(CLIENT_PORTS.imaps);
    this.smtps = this.smtp(true, tls, stored.hostname);
    this.smtps.listen(CLIENT_PORTS.smtps);
    this.submission = this.smtp(false, tls, stored.hostname);
    this.submission.listen(CLIENT_PORTS.submission);
    this.platform.logger.info({ hostname: stored.hostname }, 'IMAP and SMTP submission listening');
  }

  async stop(): Promise<void> {
    const servers = [this.imap, this.smtps, this.submission];
    this.imap = null;
    this.smtps = null;
    this.submission = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server) resolve();
            else server.close(() => resolve());
          }),
      ),
    );
  }

  shutdown(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
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
    server.on('error', (error) =>
      this.platform.logger.warn({ err: error }, 'smtp submission error'),
    );
    return server;
  }

  private async allowed(session: SMTPServerSession, address: string): Promise<boolean> {
    const account = session.user as string | undefined;
    if (!account) return false;
    return (await this.platform.mail.sendableAddresses(account)).has(address.trim().toLowerCase());
  }
}

function rejection(message: string, code: number): Error & { responseCode: number } {
  return Object.assign(new Error(message), { responseCode: code });
}
