import { PLATFORM_SCOPE } from './directory/index.js';
import { SettingsStore } from './mail/store.js';
import type { Platform } from './platform.js';
import { scopedClient } from './tenancy.js';

const KEY = 'tenant-limits';

/** Highest number of import workers one tenant may run at once. */
export const MAX_IMPORT_WORKERS = 16;

export interface TenantLimits {
  /** Imports that may run at the same time for the tenant. 0 pauses its imports. */
  importWorkers: number;
}

export const DEFAULT_LIMITS: TenantLimits = { importWorkers: 1 };

/**
 * Per-tenant resource limits. They are installation settings (platform scope), so only
 * platform operators can change them; tenant owners can read their own through the API.
 */
export class TenantLimitsService {
  private readonly settings: SettingsStore;

  constructor(platform: Platform) {
    this.settings = new SettingsStore(scopedClient(platform, PLATFORM_SCOPE));
  }

  private async load(): Promise<Record<string, Partial<TenantLimits>>> {
    return (
      (await this.settings.get<Record<string, Partial<TenantLimits>>>(PLATFORM_SCOPE, KEY)) ?? {}
    );
  }

  async get(tenantId: string): Promise<TenantLimits> {
    return { ...DEFAULT_LIMITS, ...(await this.load())[tenantId] };
  }

  /** Limits for every tenant that has any; others use the defaults. */
  async all(): Promise<Map<string, TenantLimits>> {
    const stored = await this.load();
    return new Map(
      Object.entries(stored).map(([tenantId, limits]) => [
        tenantId,
        { ...DEFAULT_LIMITS, ...limits },
      ]),
    );
  }

  async set(tenantId: string, patch: Partial<TenantLimits>): Promise<TenantLimits> {
    const stored = await this.load();
    const next = { ...DEFAULT_LIMITS, ...stored[tenantId], ...patch };
    await this.settings.set(PLATFORM_SCOPE, KEY, { ...stored, [tenantId]: next });
    return next;
  }
}
