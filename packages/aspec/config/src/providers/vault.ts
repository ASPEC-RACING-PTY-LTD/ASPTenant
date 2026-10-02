import { ConfigError } from '../errors.js';
import type { SecretProvider } from './types.js';

export interface VaultKvV2Options {
  /** Vault base URL, for example https://vault.example.com */
  address: string;
  /** Absolute mount path without trailing slash, for example secret */
  mount?: string;
  /** Token auth. Prefer AppRole in production. */
  token?: string;
  roleId?: string;
  secretId?: string;
  namespace?: string;
  /** Cache TTL in milliseconds. Default 30000. */
  cacheTtlMs?: number;
  fetch?: typeof fetch;
}

interface CacheEntry {
  value: string;
  expires: number;
}

/**
 * HashiCorp Vault KV v2 over fetch. Tested against an in-process mock only;
 * mark the vault service as untested in production docs until integration runs.
 */
export function createVaultKvV2Provider(options: VaultKvV2Options): SecretProvider {
  const mount = options.mount ?? 'secret';
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new ConfigError('CONFIG_PROVIDER_ERROR', 'fetch is not available for Vault');
  }
  let token = options.token;
  const cache = new Map<string, CacheEntry>();

  async function ensureToken(): Promise<string> {
    if (token) return token;
    if (!options.roleId || !options.secretId) {
      throw new ConfigError('CONFIG_PROVIDER_ERROR', 'Vault needs token or AppRole credentials');
    }
    const res = await doFetch(new URL('/v1/auth/approle/login', options.address), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ role_id: options.roleId, secret_id: options.secretId }),
    });
    if (!res.ok) {
      throw new ConfigError('CONFIG_PROVIDER_ERROR', `Vault AppRole login failed (${res.status})`);
    }
    const body = (await res.json()) as { auth?: { client_token?: string } };
    token = body.auth?.client_token;
    if (!token)
      throw new ConfigError('CONFIG_PROVIDER_ERROR', 'Vault AppRole login returned no token');
    return token;
  }

  function headers(tok?: string): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (tok) h['X-Vault-Token'] = tok;
    if (options.namespace) h['X-Vault-Namespace'] = options.namespace;
    return h;
  }

  return {
    name: 'vault-kv-v2',
    async getSecret(id: string): Promise<string> {
      const cached = cache.get(id);
      if (cached && cached.expires > Date.now()) return cached.value;
      const tok = await ensureToken();
      // id is `path` or `path#key` (default key "value")
      const [path, key = 'value'] = id.split('#');
      const url = new URL(`/v1/${mount}/data/${path}`, options.address);
      const res = await doFetch(url, { headers: headers(tok) });
      if (res.status === 404) {
        throw new ConfigError('CONFIG_PROVIDER_ERROR', `Vault secret not found: ${path}`);
      }
      if (!res.ok) {
        throw new ConfigError(
          'CONFIG_PROVIDER_ERROR',
          `Vault read failed (${res.status}) for ${path}`,
        );
      }
      const body = (await res.json()) as { data?: { data?: Record<string, unknown> } };
      const data = body.data?.data;
      const value = data?.[key];
      if (typeof value !== 'string') {
        throw new ConfigError(
          'CONFIG_PROVIDER_ERROR',
          `Vault secret ${path} has no string field "${key}"`,
        );
      }
      cache.set(id, { value, expires: Date.now() + cacheTtlMs });
      return value;
    },
  };
}
