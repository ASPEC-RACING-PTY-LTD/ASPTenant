import { createSign, generateKeyPairSync } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { UnprocessableError } from '@aspec/errors';
import { SettingsStore } from '../mail/store.js';
import type { Platform } from '../platform.js';

const KEY = 'domainconnect';

/** Domain Connect synchronous flow (https://www.domainconnect.org). Cloudflare requires signed requests. */
interface StoredDomainConnect {
  providerId: string;
  serviceId: string;
  /** Host label of the public key TXT record under the template's syncPubKeyDomain. */
  keyId: string;
  privateKey: string | null;
  publicKey: string | null;
}

export interface DomainConnectView {
  configured: boolean;
  providerId: string;
  serviceId: string;
  keyId: string;
  publicKey: string | null;
  /** TXT value to publish at <keyId>.<syncPubKeyDomain>. */
  publicKeyTxt: string | null;
}

export type DomainConnectResult =
  | { supported: true; providerName: string; applyUrl: string }
  | { supported: false; providerName: string | null; reason: string };

const DEFAULTS: StoredDomainConnect = {
  providerId: 'aspecracing.com.au',
  serviceId: 'aspectenant-mail',
  keyId: '_dck1',
  privateKey: null,
  publicKey: null,
};

export type TxtLookup = (name: string) => Promise<string[]>;

function publicTxt(): TxtLookup {
  return async (name) => {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    r.setServers(['1.1.1.1', '8.8.8.8']);
    try {
      return (await r.resolveTxt(name)).map((parts) => parts.join(''));
    } catch {
      return [];
    }
  };
}

/** Signs a query string with RS256 as the Domain Connect spec requires (base64 signature). */
export function signQuery(query: string, privateKey: string): string {
  return createSign('RSA-SHA256').update(query).sign(privateKey, 'base64');
}

/** Builds the apply URL: parameters, then key, then sig last (Cloudflare requires sig last). */
export function buildApplyUrl(input: {
  urlSyncUX: string;
  providerId: string;
  serviceId: string;
  params: Record<string, string>;
  keyId: string;
  privateKey: string;
}): string {
  const query = new URLSearchParams(input.params).toString();
  const sig = signQuery(query, input.privateKey);
  const base = `${input.urlSyncUX.replace(/\/$/, '')}/v2/domainTemplates/providers/${encodeURIComponent(
    input.providerId,
  )}/services/${encodeURIComponent(input.serviceId)}/apply`;
  return `${base}?${query}&key=${encodeURIComponent(input.keyId)}&sig=${encodeURIComponent(sig)}`;
}

export class DomainConnect {
  private readonly platform: Platform;
  private readonly settings: SettingsStore;
  /** Overridable for tests. */
  txt: TxtLookup = publicTxt();

  constructor(platform: Platform) {
    this.platform = platform;
    this.settings = new SettingsStore(platform.db);
  }

  private async tenantId(): Promise<string> {
    return (await this.platform.orgs.getDefaultOrg()).id;
  }

  private async load(): Promise<StoredDomainConnect> {
    return {
      ...DEFAULTS,
      ...((await this.settings.get<StoredDomainConnect>(await this.tenantId(), KEY)) ?? {}),
    };
  }

  async view(): Promise<DomainConnectView> {
    const stored = await this.load();
    let publicKeyTxt: string | null = null;
    if (stored.publicKey) {
      const der = stored.publicKey.replace(/-----[^-]+-----|\s+/g, '');
      publicKeyTxt = `p=1,a=RS256,d=${der}`;
    }
    return {
      configured: Boolean(stored.privateKey && stored.providerId && stored.serviceId),
      providerId: stored.providerId,
      serviceId: stored.serviceId,
      keyId: stored.keyId,
      publicKey: stored.publicKey,
      publicKeyTxt,
    };
  }

  async update(input: {
    providerId: string;
    serviceId: string;
    keyId: string;
    privateKey?: string;
    generateKey?: boolean;
  }): Promise<DomainConnectView> {
    const stored = await this.load();
    const next: StoredDomainConnect = {
      ...stored,
      providerId: input.providerId.trim(),
      serviceId: input.serviceId.trim(),
      keyId: input.keyId.trim(),
    };
    if (input.generateKey) {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      next.privateKey = this.platform.secrets.encrypt(
        pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );
      next.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    } else if (input.privateKey?.trim()) {
      try {
        signQuery('test', input.privateKey.trim());
      } catch {
        throw new UnprocessableError('That is not a valid RSA private key in PEM format.');
      }
      next.privateKey = this.platform.secrets.encrypt(input.privateKey.trim());
      next.publicKey = null;
    }
    await this.settings.set(await this.tenantId(), KEY, next);
    return this.view();
  }

  /** Finds the domain's DNS provider through its _domainconnect TXT record. */
  async discover(
    domain: string,
  ): Promise<{ providerName: string; urlSyncUX: string; urlAPI: string } | null> {
    const host = (await this.txt(`_domainconnect.${domain}`))[0]?.trim();
    if (!host) return null;
    const response = await fetch(`https://${host}/v2/${encodeURIComponent(domain)}/settings`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      providerName?: string;
      urlSyncUX?: string;
      urlAPI?: string;
    } | null;
    if (!body?.urlSyncUX || !body.urlAPI) return null;
    return {
      providerName: body.providerName ?? host,
      urlSyncUX: body.urlSyncUX,
      urlAPI: body.urlAPI,
    };
  }

  /** Signed apply URL that adds the verification and mail records for a domain. */
  async applyUrl(
    domain: string,
    variables: Record<string, string>,
    redirectUri: string,
  ): Promise<DomainConnectResult> {
    const stored = await this.load();
    if (!stored.privateKey) {
      return {
        supported: false,
        providerName: null,
        reason: 'Domain Connect signing is not configured (Settings).',
      };
    }
    const provider = await this.discover(domain);
    if (!provider) {
      return {
        supported: false,
        providerName: null,
        reason: "This domain's DNS provider does not support Domain Connect.",
      };
    }
    const template = await fetch(
      `${provider.urlAPI.replace(/\/$/, '')}/v2/domainTemplates/providers/${encodeURIComponent(
        stored.providerId,
      )}/services/${encodeURIComponent(stored.serviceId)}`,
      { signal: AbortSignal.timeout(10_000) },
    ).catch(() => null);
    if (!template?.ok) {
      return {
        supported: false,
        providerName: provider.providerName,
        reason: `${provider.providerName} supports Domain Connect but has not onboarded the ASPECTenant template yet.`,
      };
    }
    return {
      supported: true,
      providerName: provider.providerName,
      applyUrl: buildApplyUrl({
        urlSyncUX: provider.urlSyncUX,
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        params: { domain, ...variables, redirect_uri: redirectUri },
        keyId: stored.keyId,
        privateKey: this.platform.secrets.decrypt(stored.privateKey),
      }),
    };
  }
}
