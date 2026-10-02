import { Resolver } from 'node:dns/promises';
import { NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import type { DirectoryDomain } from '../directory/index.js';
import { SettingsStore } from '../mail/store.js';
import type { Platform } from '../platform.js';

const KEY = 'cloudflare';

/** Public resolvers, so answers are not stale copies from the host or Docker DNS cache. */
function resolver(): Resolver {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

const PROVIDERS: { match: RegExp; id: string; name: string }[] = [
  { match: /\.ns\.cloudflare\.com$/, id: 'cloudflare', name: 'Cloudflare' },
  { match: /awsdns/, id: 'route53', name: 'Amazon Route 53' },
  { match: /domaincontrol\.com$/, id: 'godaddy', name: 'GoDaddy' },
  { match: /azure-dns\./, id: 'azure', name: 'Azure DNS' },
  {
    match: /googledomains\.com$|ns-cloud-[a-z]\d*\.googledomains|\.google\.com$/,
    id: 'google',
    name: 'Google Cloud DNS',
  },
  { match: /registrar-servers\.com$/, id: 'namecheap', name: 'Namecheap' },
  { match: /digitalocean\.com$/, id: 'digitalocean', name: 'DigitalOcean' },
  { match: /crazydomains|syrahost/, id: 'crazydomains', name: 'Crazy Domains' },
  { match: /ventraip|nameserver\.net\.au$/, id: 'ventraip', name: 'VentraIP' },
];

export interface DnsProvider {
  id: string;
  name: string;
  nameservers: string[];
}

export interface RequiredRecord {
  key: string;
  purpose: string;
  type: 'MX' | 'TXT' | 'A' | 'SRV' | 'CNAME';
  name: string;
  content: string;
  priority?: number;
  status: 'ok' | 'missing' | 'different';
  found: string[];
  automatic: boolean;
}

export interface DomainSetupView {
  domain: DirectoryDomain;
  provider: DnsProvider;
  cloudflare: { connected: boolean; zone: boolean };
  verification: { name: string; value: string; found: boolean };
  records: RequiredRecord[];
  manualSteps: string[];
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export class CloudflareApi {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({ success: false }))) as {
      success: boolean;
      errors?: { message: string }[];
      result: T;
    };
    if (!body.success) {
      throw new UnprocessableError(
        `Cloudflare: ${body.errors?.map((e) => e.message).join(', ') || `HTTP ${response.status}`}`,
      );
    }
    return body.result;
  }

  async zoneFor(hostname: string): Promise<{ id: string; name: string } | null> {
    const labels = hostname.split('.');
    for (let i = 0; i < labels.length - 1; i += 1) {
      const name = labels.slice(i).join('.');
      const zones = await this.call<{ id: string; name: string }[]>(
        `/zones?name=${encodeURIComponent(name)}`,
      );
      if (zones[0]) return zones[0];
    }
    return null;
  }

  records(zone: string, type: string, name: string): Promise<CfRecord[]> {
    return this.call<CfRecord[]>(
      `/zones/${zone}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
    );
  }

  create(zone: string, record: Record<string, unknown>): Promise<CfRecord> {
    return this.call<CfRecord>(`/zones/${zone}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ ttl: 1, ...record }),
    });
  }
}

async function publicIp(): Promise<string | null> {
  try {
    const text = await (
      await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) })
    ).text();
    return /^ip=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export class DomainSetup {
  private readonly platform: Platform;
  private readonly settings: SettingsStore;

  constructor(platform: Platform) {
    this.platform = platform;
    this.settings = new SettingsStore(platform.db);
  }

  private async tenantId(): Promise<string> {
    return (await this.platform.orgs.getDefaultOrg()).id;
  }

  /** Cloudflare API token shared by DNS setup and certificates (stored encrypted). */
  async cloudflareToken(): Promise<string | null> {
    const stored = await this.settings.get<{ apiToken?: string }>(await this.tenantId(), KEY);
    return stored?.apiToken ? this.platform.secrets.decrypt(stored.apiToken) : null;
  }

  async connectCloudflare(token: string, actor: Actor): Promise<{ zones: string[] }> {
    const api = new CloudflareApi(token.trim());
    const zones = await api.call<{ name: string }[]>('/zones?per_page=50');
    await this.settings.set(await this.tenantId(), KEY, {
      apiToken: this.platform.secrets.encrypt(token.trim()),
    });
    await this.platform.audit.record({
      action: 'integration.cloudflare.connected',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'integration', id: KEY },
      changes: { after: { zones: zones.map((zone) => zone.name) } },
    });
    return { zones: zones.map((zone) => zone.name) };
  }

  async disconnectCloudflare(): Promise<void> {
    await this.settings.set(await this.tenantId(), KEY, {});
  }

  async status(): Promise<{ connected: boolean }> {
    return { connected: Boolean(await this.cloudflareToken()) };
  }

  async detectProvider(hostname: string): Promise<DnsProvider> {
    const labels = hostname.split('.');
    for (let i = 0; i < labels.length - 1; i += 1) {
      try {
        const nameservers = (await resolver().resolveNs(labels.slice(i).join('.'))).map((ns) =>
          ns.toLowerCase(),
        );
        if (nameservers.length === 0) continue;
        const known = PROVIDERS.find((provider) =>
          nameservers.some((ns) => provider.match.test(ns)),
        );
        return {
          id: known?.id ?? 'other',
          name: known?.name ?? 'Your DNS provider',
          nameservers,
        };
      } catch {
        // try the parent name
      }
    }
    return { id: 'unknown', name: 'Unknown', nameservers: [] };
  }

  private async domain(id: string): Promise<DirectoryDomain> {
    const domain = await this.platform.directory.store.getDomain(await this.tenantId(), id);
    if (!domain) throw new NotFoundError('Domain not found');
    return domain;
  }

  private async txt(name: string): Promise<string[]> {
    try {
      return (await resolver().resolveTxt(name)).map((parts) => parts.join(''));
    } catch {
      return [];
    }
  }

  async view(id: string): Promise<DomainSetupView> {
    const domain = await this.domain(id);
    const [provider, token] = await Promise.all([
      this.detectProvider(domain.hostname),
      this.cloudflareToken(),
    ]);
    const verification = this.platform.directory.domainVerification(domain);
    const rootTxt = await this.txt(domain.hostname);
    let zone: { id: string } | null = null;
    if (token) zone = await new CloudflareApi(token).zoneFor(domain.hostname).catch(() => null);
    const records =
      domain.status === 'verified' ? await this.requiredRecords(domain, token, zone) : [];
    const manualSteps: string[] = [];
    if (domain.status === 'verified') {
      manualSteps.push(
        provider.id === 'cloudflare'
          ? 'DKIM for sending: in Cloudflare open Email > Email Sending and onboard this domain. Cloudflare adds the DKIM and bounce records itself.'
          : 'Inbound mail through Cloudflare Email Routing needs the domain on Cloudflare DNS. Otherwise point MX at your own mail relay.',
        'Inbound delivery: deploy the Worker shown on Mail settings and set the Email Routing catch-all to it.',
      );
    }
    return {
      domain,
      provider,
      cloudflare: { connected: Boolean(token), zone: Boolean(zone) },
      verification: { ...verification, found: rootTxt.includes(verification.value) },
      records,
      manualSteps,
    };
  }

  private async requiredRecords(
    domain: DirectoryDomain,
    token: string | null,
    zone: { id: string } | null,
  ): Promise<RequiredRecord[]> {
    const host = domain.hostname;
    const dns = resolver();
    const out: RequiredRecord[] = [];

    // Inbound MX and SPF: ask Cloudflare for its exact Email Routing records when possible.
    let routing: { type: string; name: string; content: string; priority?: number }[] = [];
    if (token && zone) {
      routing = await new CloudflareApi(token)
        .call<typeof routing>(`/zones/${zone.id}/email/routing/dns`)
        .catch(() => []);
    }
    if (routing.length === 0) {
      routing = [
        { type: 'MX', name: host, content: 'route1.mx.cloudflare.net', priority: 10 },
        { type: 'MX', name: host, content: 'route2.mx.cloudflare.net', priority: 20 },
        { type: 'MX', name: host, content: 'route3.mx.cloudflare.net', priority: 30 },
        { type: 'TXT', name: host, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      ];
    }
    const mx = await dns.resolveMx(host).catch(() => []);
    const rootTxt = await this.txt(host);
    for (const record of routing) {
      const name = record.name === '@' ? host : record.name;
      if (record.type === 'MX') {
        const ok = mx.some((item) => item.exchange.toLowerCase() === record.content.toLowerCase());
        out.push({
          key: `mx:${record.content}`,
          purpose: 'Receive mail (Cloudflare Email Routing)',
          type: 'MX',
          name,
          content: record.content,
          ...(record.priority !== undefined ? { priority: record.priority } : {}),
          status: ok ? 'ok' : mx.length ? 'different' : 'missing',
          found: mx.map((item) => `${item.priority} ${item.exchange}`),
          automatic: Boolean(zone),
        });
      } else if (record.type === 'TXT' && record.content.startsWith('v=spf1')) {
        const spf = rootTxt.find((value) => value.toLowerCase().startsWith('v=spf1'));
        out.push({
          key: 'spf',
          purpose: 'SPF: which servers may send for this domain',
          type: 'TXT',
          name,
          content: record.content,
          status: spf?.includes('_spf.mx.cloudflare.net') ? 'ok' : spf ? 'different' : 'missing',
          found: spf ? [spf] : [],
          automatic: Boolean(zone),
        });
      }
    }

    const dmarc = (await this.txt(`_dmarc.${host}`)).find((value) =>
      value.toLowerCase().startsWith('v=dmarc1'),
    );
    out.push({
      key: 'dmarc',
      purpose: 'DMARC: tells receivers to quarantine spoofed mail',
      type: 'TXT',
      name: `_dmarc.${host}`,
      content: 'v=DMARC1; p=quarantine; adkim=r; aspf=r',
      status: dmarc ? 'ok' : 'missing',
      found: dmarc ? [dmarc] : [],
      automatic: Boolean(zone),
    });

    // Mail apps: hostname record plus RFC 6186 service records for automatic setup.
    const clients = await this.platform.mailServers.view();
    const mailHost = clients.hostname;
    if (mailHost && (mailHost === host || mailHost.endsWith(`.${host}`))) {
      const ip = await publicIp();
      const current: string[] = await dns.resolve4(mailHost).catch(() => []);
      if (ip) {
        out.push({
          key: 'mailhost',
          purpose: 'Mail apps hostname (DNS only, not proxied)',
          type: 'A',
          name: mailHost,
          content: ip,
          status: current.includes(ip) ? 'ok' : current.length ? 'different' : 'missing',
          found: current,
          automatic: Boolean(zone),
        });
      }
      for (const [service, port] of [
        ['_imaps._tcp', clients.ports.imaps],
        ['_submission._tcp', clients.ports.submission],
      ] as const) {
        const name = `${service}.${host}`;
        const srv = await dns.resolveSrv(name).catch(() => []);
        out.push({
          key: `srv:${service}`,
          purpose: 'Lets mail apps find the server automatically',
          type: 'SRV',
          name,
          content: `0 1 ${port} ${mailHost}`,
          status: srv.some((item) => item.name === mailHost && item.port === port)
            ? 'ok'
            : 'missing',
          found: srv.map((item) => `${item.priority} ${item.weight} ${item.port} ${item.name}`),
          automatic: Boolean(zone),
        });
      }
    }
    return out;
  }

  /** Proves ownership through the Cloudflare API: publishes the TXT record and verifies. */
  async verifyWithCloudflare(id: string, actor: Actor): Promise<DirectoryDomain> {
    const domain = await this.domain(id);
    const token = await this.cloudflareToken();
    if (!token) throw new UnprocessableError('Connect Cloudflare first.');
    const api = new CloudflareApi(token);
    const zone = await api.zoneFor(domain.hostname);
    if (!zone)
      throw new UnprocessableError(`${domain.hostname} is not in this Cloudflare account.`);
    const verification = this.platform.directory.domainVerification(domain);
    const existing = await api.records(zone.id, 'TXT', verification.name);
    if (!existing.some((record) => record.content.replace(/"/g, '') === verification.value)) {
      await api.create(zone.id, {
        type: 'TXT',
        name: verification.name,
        content: verification.value,
      });
    }
    return this.platform.directory.markVerified(id, actor, 'cloudflare-api');
  }

  /** Creates every missing record through Cloudflare. Existing different records are left alone. */
  async applyRecords(id: string, actor: Actor): Promise<{ created: string[]; skipped: string[] }> {
    const domain = await this.domain(id);
    if (domain.status !== 'verified') throw new UnprocessableError('Verify the domain first.');
    const token = await this.cloudflareToken();
    if (!token) throw new UnprocessableError('Connect Cloudflare first.');
    const api = new CloudflareApi(token);
    const zone = await api.zoneFor(domain.hostname);
    if (!zone)
      throw new UnprocessableError(`${domain.hostname} is not in this Cloudflare account.`);
    const records = await this.requiredRecords(domain, token, zone);
    const created: string[] = [];
    const skipped: string[] = [];
    const needsRouting = records.some(
      (record) => (record.type === 'MX' || record.key === 'spf') && record.status === 'missing',
    );
    if (needsRouting) {
      await api.call(`/zones/${zone.id}/email/routing/dns`, {
        method: 'POST',
        body: JSON.stringify({ name: domain.hostname }),
      });
      created.push('Email Routing MX and SPF');
    }
    for (const record of records) {
      if (record.type === 'MX' || record.key === 'spf') {
        if (record.status === 'different')
          skipped.push(`${record.type} ${record.name} (existing record kept)`);
        continue;
      }
      if (record.status !== 'missing') {
        if (record.status === 'different')
          skipped.push(`${record.type} ${record.name} (existing record kept)`);
        continue;
      }
      if (record.type === 'SRV') {
        const [priority, weight, port, target] = record.content.split(' ');
        await api.create(zone.id, {
          type: 'SRV',
          name: record.name,
          data: { priority: Number(priority), weight: Number(weight), port: Number(port), target },
        });
      } else {
        await api.create(zone.id, {
          type: record.type,
          name: record.name,
          content: record.content,
          ...(record.type === 'A' ? { proxied: false } : {}),
        });
      }
      created.push(`${record.type} ${record.name}`);
    }
    await this.platform.audit.record({
      action: 'directory.domain.dns_configured',
      outcome: 'success',
      category: 'admin',
      actor,
      resource: { type: 'domain', id },
      changes: { after: { created, skipped } },
    });
    return { created, skipped };
  }
}
