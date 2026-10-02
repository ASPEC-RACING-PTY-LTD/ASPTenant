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

export type CloudflareFailure = 'auth' | 'permission' | 'not-found' | 'api';

/** A Cloudflare problem with a cause the UI can explain. */
export class CloudflareError extends UnprocessableError {
  readonly kind: CloudflareFailure;

  constructor(kind: CloudflareFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface ZoneMatch {
  id: string;
  name: string;
  /** True when the hostname is below the zone apex (for example mail.example.com in example.com). */
  subdomain: boolean;
}

/** Cloudflare error codes for a missing, invalid or expired token. */
const AUTH_CODES = new Set([9103, 9106, 9109, 10000, 10001, 6003, 6111]);

/**
 * Finds the Cloudflare zone that is authoritative for a hostname: the longest zone name the
 * token can see that equals the hostname or is a parent of it. The hostname itself is never
 * assumed to be a zone.
 */
export async function discoverZone(token: string, hostname: string): Promise<ZoneMatch> {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const zones: { id: string; name: string }[] = [];
  for (let page = 1; page <= 20; page += 1) {
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`,
        {
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch (error) {
      throw new CloudflareError(
        'api',
        `Could not reach the Cloudflare API: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const body = (await response.json().catch(() => ({ success: false }))) as {
      success: boolean;
      errors?: { code: number; message: string }[];
      result?: { id: string; name: string }[];
      result_info?: { total_pages?: number };
    };
    if (!body.success) {
      const codes = (body.errors ?? []).map((e) => e.code);
      const detail = body.errors?.map((e) => e.message).join(', ') || `HTTP ${response.status}`;
      if (response.status === 401 || codes.some((code) => AUTH_CODES.has(code))) {
        throw new CloudflareError(
          'auth',
          `Cloudflare rejected the API token (authentication failed: ${detail}). Check the token is correct and not expired or revoked.`,
        );
      }
      if (response.status === 403) {
        throw new CloudflareError(
          'permission',
          `The Cloudflare token is not allowed to list zones (${detail}). Give it Zone: Read and DNS: Edit.`,
        );
      }
      throw new CloudflareError('api', `Cloudflare API error: ${detail}`);
    }
    zones.push(...(body.result ?? []));
    if (page >= (body.result_info?.total_pages ?? 1)) break;
  }
  if (zones.length === 0) {
    throw new CloudflareError(
      'permission',
      `The Cloudflare token is valid but cannot see any zones. Give it Zone: Read and DNS: Edit for the zone that contains ${host}.`,
    );
  }
  const match = zones
    .filter((zone) => {
      const name = zone.name.toLowerCase();
      return host === name || host.endsWith(`.${name}`);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!match) {
    throw new CloudflareError(
      'not-found',
      `No zone in this Cloudflare account contains ${host}. Zones this token can see: ${zones
        .map((zone) => zone.name)
        .slice(0, 20)
        .join(', ')}.`,
    );
  }
  return { id: match.id, name: match.name, subdomain: host !== match.name.toLowerCase() };
}

/**
 * Proves the token may edit DNS in the zone by creating and deleting a throwaway TXT record.
 * Zone: Read alone lets a token find the zone but not publish the ACME challenge.
 */
export async function checkDnsWrite(
  token: string,
  zone: ZoneMatch,
  hostname: string,
): Promise<void> {
  const base = `https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const parse = async (response: Response) =>
    (await response.json().catch(() => ({ success: false }))) as {
      success: boolean;
      errors?: { code: number; message: string }[];
      result?: { id: string };
    };
  let created: Awaited<ReturnType<typeof parse>>;
  let status = 0;
  try {
    const response = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'TXT',
        name: `_aspectenant-check.${hostname}`,
        content: 'aspectenant-dns-write-check',
        ttl: 60,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    status = response.status;
    created = await parse(response);
  } catch (error) {
    throw new CloudflareError(
      'api',
      `Could not reach the Cloudflare API: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!created.success) {
    const codes = (created.errors ?? []).map((e) => e.code);
    const detail = created.errors?.map((e) => e.message).join(', ') || `HTTP ${status}`;
    if (status === 401 || status === 403 || codes.some((code) => AUTH_CODES.has(code))) {
      throw new CloudflareError(
        'permission',
        `The token can read zone ${zone.name} but cannot edit its DNS records (${detail}). Give it DNS: Edit for ${zone.name}.`,
      );
    }
    throw new CloudflareError(
      'api',
      `Cloudflare refused a test DNS record in ${zone.name}: ${detail}`,
    );
  }
  if (created.result?.id) {
    await fetch(`${base}/${created.result.id}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
  }
}

export interface DnsChallengePlan {
  /** Name on the certificate. Never changed. */
  certificateHostname: string;
  /** TXT record created for the ACME DNS-01 challenge. */
  recordName: string;
  zone: ZoneMatch;
  token: string;
  tokenSource: string;
}

/** Picks the first token whose account holds the zone for the hostname, reporting each failure. */
export async function planDnsChallenge(
  hostname: string,
  candidates: { source: string; token: string }[],
): Promise<DnsChallengePlan> {
  const host = hostname.trim().toLowerCase();
  if (candidates.length === 0) {
    throw new CloudflareError(
      'auth',
      'No Cloudflare token is configured. Connect Cloudflare on the Domains page or save a token on Mail apps.',
    );
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const zone = await discoverZone(candidate.token, host);
      await checkDnsWrite(candidate.token, zone, host);
      return {
        certificateHostname: host,
        recordName: `_acme-challenge.${host}`,
        zone,
        token: candidate.token,
        tokenSource: candidate.source,
      };
    } catch (error) {
      failures.push(
        `${candidate.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (candidates.length === 1) throw error;
    }
  }
  throw new UnprocessableError(
    `No Cloudflare token can manage DNS for ${host}. ${failures.join(' ')}`,
  );
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

  /** Longest matching zone for the hostname, or null when the token cannot see one. */
  async zoneFor(hostname: string): Promise<{ id: string; name: string } | null> {
    try {
      return await discoverZone(this.token, hostname);
    } catch (error) {
      if (error instanceof CloudflareError && error.kind === 'not-found') return null;
      throw error;
    }
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
      const name = record.name === '@' ? host : record.name.replace(/\.$/, '');
      if (record.type === 'MX') {
        // Cloudflare returns FQDNs with a trailing dot and picks arbitrary priorities per zone.
        // The MX host is what matters; any priority routes mail to Email Routing.
        const exchange = record.content.replace(/\.$/, '').toLowerCase();
        const existing = mx.find(
          (item) => item.exchange.replace(/\.$/, '').toLowerCase() === exchange,
        );
        const ok = Boolean(existing);
        out.push({
          key: `mx:${record.content}`,
          purpose: 'Receive mail (Cloudflare Email Routing)',
          type: 'MX',
          name,
          content: exchange,
          ...(existing
            ? { priority: existing.priority }
            : record.priority !== undefined
              ? { priority: record.priority }
              : {}),
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
