import { randomBytes } from 'node:crypto';
import { ApiKeysError, argumentError, configError, notFound, validationError } from './errors.js';
import { createIdGenerator } from './ids.js';
import {
  assertPrefix,
  dummyHashCompare,
  generateKey,
  hashesEqual,
  hashKey,
  parseKey,
  parsePepper,
  rebuildKeyWithPublicId,
} from './key-format.js';
import type {
  AuditSink,
  CacheLike,
  Clock,
  IdGenerator,
  LoggerLike,
  RateLimiterLike,
} from './ports.js';
import { assertScopes, hasAllScopes, scopesEscalate, validateAgainstCatalogue } from './scopes.js';
import type { ApiKeysStore } from './store.js';
import type {
  ApiKey,
  ApiKeyRecord,
  CreatedApiKey,
  KeyListQuery,
  OwnerType,
  Page,
  ServiceAccount,
  ServiceAccountListQuery,
  ServiceAccountRecord,
  VerifiedPrincipal,
} from './types.js';
import { toApiKey, toServiceAccount } from './types.js';
import { createUsageTracker, type UsageTracker } from './usage.js';

const DAY = 86_400_000;
const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const API_KEYS_PERMISSIONS = [
  'api_keys:read',
  'api_keys:create',
  'api_keys:rotate',
  'api_keys:revoke',
  'api_keys:update',
  'api_keys:service_accounts',
] as const;

export type ApiKeysPermission = (typeof API_KEYS_PERMISSIONS)[number];

export interface CreateKeyInput {
  name: string;
  scopes: readonly string[];
  ownerType: OwnerType;
  ownerId: string;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: number | null;
  ttlMs?: number;
  neverExpires?: boolean;
  rateLimit?: number | null;
  rateLimitWindowMs?: number | null;
}

export interface UpdateKeyInput {
  name?: string;
  scopes?: readonly string[];
  metadata?: Record<string, unknown>;
  rateLimit?: number | null;
  rateLimitWindowMs?: number | null;
  allowEscalation?: boolean;
}

export interface RotateKeyInput {
  gracePeriodMs?: number;
}

export interface RevokeKeyInput {
  reason?: string;
  actor?: string;
}

export interface CreateServiceAccountInput {
  name: string;
  description?: string | null;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateServiceAccountInput {
  name?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  enabled?: boolean;
}

export interface VerifyOptions {
  scopes?: readonly string[];
  ip?: string | null;
  skipUsage?: boolean;
}

export interface VerifyResult {
  ok: true;
  principal: VerifiedPrincipal;
  record: ApiKeyRecord;
}

export interface VerifyFailure {
  ok: false;
  code: 'API_KEYS_UNAUTHORIZED' | 'API_KEYS_SCOPE_DENIED' | 'API_KEYS_RATE_LIMITED';
  status: 401 | 403 | 429;
  retryAfterMs?: number;
}

export interface ApiKeysOptions {
  store: ApiKeysStore;
  pepper?: string | Buffer;
  cache?: CacheLike;
  rateLimiter?: RateLimiterLike;
  audit?: AuditSink;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  prefix?: string;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  scopeCatalogue?: readonly string[];
  cacheTtlMs?: number;
  usageFlushIntervalMs?: number;
  verificationFailureSampleRate?: number;
  nodeEnv?: string;
}

export interface ApiKeys {
  create(input: CreateKeyInput): Promise<CreatedApiKey>;
  get(id: string): Promise<ApiKey>;
  getByPublicId(publicId: string): Promise<ApiKey>;
  list(query?: KeyListQuery): Promise<Page<ApiKey>>;
  expiringWithin(
    days: number,
    query?: Omit<KeyListQuery, 'expiringWithinDays'>,
  ): Promise<Page<ApiKey>>;
  update(id: string, input: UpdateKeyInput): Promise<ApiKey>;
  rotate(id: string, input?: RotateKeyInput): Promise<CreatedApiKey>;
  revoke(id: string, input?: RevokeKeyInput): Promise<ApiKey>;
  verify(rawKey: string, options?: VerifyOptions): Promise<VerifyResult | VerifyFailure>;
  createServiceAccount(input: CreateServiceAccountInput): Promise<ServiceAccount>;
  getServiceAccount(id: string): Promise<ServiceAccount>;
  listServiceAccounts(query?: ServiceAccountListQuery): Promise<Page<ServiceAccount>>;
  updateServiceAccount(id: string, input: UpdateServiceAccountInput): Promise<ServiceAccount>;
  deleteServiceAccount(id: string): Promise<void>;
  shutdown(): Promise<void>;
  readonly usage: UsageTracker;
}

function assertName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
    throw validationError('name must be 1-120 characters');
  }
  return name.trim();
}

function assertMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (metadata === undefined) return {};
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw validationError('metadata must be a plain object');
  }
  const json = JSON.stringify(metadata);
  if (json.length > 8_192) throw validationError('metadata must be at most 8192 bytes of JSON');
  return { ...metadata };
}

function cacheKey(publicId: string): string {
  return `api_keys:pub:${publicId}`;
}

/** Creates the API keys service. */
export function createApiKeys(options: ApiKeysOptions): ApiKeys {
  if (!options || typeof options !== 'object') throw configError('options', 'must be an object');
  if (!options.store) throw configError('store', 'is required');
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const pepperSource = options.pepper ?? process.env.API_KEYS_PEPPER;
  const logger = options.logger ?? noopLogger;
  const pepper = parsePepper(
    typeof pepperSource === 'string' || Buffer.isBuffer(pepperSource) ? pepperSource : undefined,
    nodeEnv,
  );
  if ((pepperSource === undefined || pepperSource === '') && nodeEnv !== 'production') {
    logger.warn(
      { option: 'pepper' },
      'API_KEYS_PEPPER missing; using insecure development fallback. Set a 32+ byte pepper before production.',
    );
  }
  const prefix = assertPrefix(options.prefix ?? 'ak_live_');
  const defaultTtlMs = options.defaultTtlMs ?? 90 * DAY;
  const maxTtlMs = options.maxTtlMs ?? 365 * DAY;
  if (!Number.isFinite(defaultTtlMs) || defaultTtlMs < 1) {
    throw configError('defaultTtlMs', 'must be a positive number');
  }
  if (!Number.isFinite(maxTtlMs) || maxTtlMs < defaultTtlMs) {
    throw configError('maxTtlMs', 'must be >= defaultTtlMs');
  }
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const generateId: IdGenerator = options.generateId ?? createIdGenerator();
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const sampleRate = options.verificationFailureSampleRate ?? 0.1;
  const usage = createUsageTracker({
    store: options.store,
    flushIntervalMs: options.usageFlushIntervalMs ?? 5000,
    logger,
  });
  const catalogue = options.scopeCatalogue;

  const audit = async (
    action: string,
    outcome: 'success' | 'failure' | 'denied',
    resourceId: string | undefined,
    metadata?: Record<string, unknown>,
    actor?: { id: string; type?: string; ip?: string },
  ) => {
    if (!options.audit) return;
    try {
      await options.audit.record({
        action,
        outcome,
        category: 'security',
        resource: resourceId ? { type: 'api_key', id: resourceId } : { type: 'api_key' },
        ...(actor ? { actor } : {}),
        ...(metadata ? { metadata } : {}),
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), action },
        'api-keys audit failed',
      );
    }
  };

  const invalidate = async (publicId: string) => {
    if (!options.cache) return;
    try {
      await options.cache.delete(cacheKey(publicId));
    } catch {
      // Cache failures are misses.
    }
  };

  const loadByPublicId = async (publicId: string): Promise<ApiKeyRecord | undefined> => {
    if (options.cache) {
      try {
        const cached = await options.cache.get<ApiKeyRecord>(cacheKey(publicId));
        if (cached) return cached;
      } catch {
        // treat as miss
      }
    }
    const record = await options.store.getKeyByPublicId(publicId);
    if (record && options.cache) {
      try {
        await options.cache.set(cacheKey(publicId), record, { ttlMs: cacheTtlMs });
      } catch {
        // ignore
      }
    }
    return record;
  };

  const resolveExpiry = (input: CreateKeyInput, now: number): number | null => {
    if (input.neverExpires) {
      if (input.expiresAt !== undefined || input.ttlMs !== undefined) {
        throw validationError('neverExpires cannot be combined with expiresAt or ttlMs');
      }
      return null;
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
        throw validationError('expiresAt must be in the future');
      }
      if (input.expiresAt - now > maxTtlMs) {
        throw validationError(`expiresAt exceeds max TTL of ${maxTtlMs}ms`);
      }
      return Math.floor(input.expiresAt);
    }
    const ttl = input.ttlMs ?? defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl < 1) throw validationError('ttlMs must be positive');
    if (ttl > maxTtlMs) throw validationError(`ttlMs exceeds max TTL of ${maxTtlMs}ms`);
    return now + Math.floor(ttl);
  };

  const service: ApiKeys = {
    usage,

    async create(input) {
      const name = assertName(input.name);
      const scopes = assertScopes(input.scopes);
      validateAgainstCatalogue(scopes, catalogue);
      if (input.ownerType !== 'user' && input.ownerType !== 'service_account') {
        throw validationError('ownerType must be user or service_account');
      }
      if (typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
        throw validationError('ownerId is required');
      }
      if (input.ownerType === 'service_account') {
        const sa = await options.store.getServiceAccount(input.ownerId);
        if (!sa) throw notFound('service_account', input.ownerId);
        if (!sa.enabled) {
          throw new ApiKeysError('API_KEYS_DISABLED', 'Service account is disabled', {
            status: 403,
            expose: true,
          });
        }
      }
      const now = clock.now();
      const parts = generateKey({ prefix });
      const record: ApiKeyRecord = {
        id: generateId(),
        publicId: parts.publicId,
        keyHash: hashKey(pepper, parts.key),
        displayPrefix: parts.displayPrefix,
        prefix: parts.prefix,
        name,
        scopes,
        status: 'active',
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orgId: input.orgId ?? null,
        metadata: assertMetadata(input.metadata),
        expiresAt: resolveExpiry(input, now),
        revokedAt: null,
        revokedReason: null,
        revokedBy: null,
        previousKeyHash: null,
        previousExpiresAt: null,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        lastUsedIp: null,
        useCount: 0,
        rateLimit: input.rateLimit ?? null,
        rateLimitWindowMs: input.rateLimitWindowMs ?? null,
      };
      await options.store.insertKey(record);
      await audit('api_keys.created', 'success', record.id, {
        publicId: record.publicId,
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        scopes: record.scopes,
      });
      return { key: toApiKey(record), secret: parts.key };
    },

    async get(id) {
      const record = await options.store.getKeyById(id);
      if (!record) throw notFound('api_key', id);
      return toApiKey(record);
    },

    async getByPublicId(publicId) {
      const record = await loadByPublicId(publicId);
      if (!record) throw notFound('api_key', publicId);
      return toApiKey(record);
    },

    async list(query = {}) {
      const now = clock.now();
      await options.store.markExpired(now);
      const page = await options.store.listKeys(query, now);
      return { ...page, items: page.items.map(toApiKey) };
    },

    async expiringWithin(days, query = {}) {
      if (!Number.isFinite(days) || days < 0) throw argumentError('days', 'must be >= 0');
      return service.list({ ...query, expiringWithinDays: days });
    },

    async update(id, input) {
      const record = await options.store.getKeyById(id);
      if (!record) throw notFound('api_key', id);
      if (record.status === 'revoked') {
        throw new ApiKeysError('API_KEYS_REVOKED', 'Key is revoked', { status: 409, expose: true });
      }
      if (input.name !== undefined) record.name = assertName(input.name);
      if (input.scopes !== undefined) {
        const scopes = assertScopes(input.scopes);
        validateAgainstCatalogue(scopes, catalogue);
        if (!input.allowEscalation && scopesEscalate(record.scopes, scopes)) {
          throw new ApiKeysError(
            'API_KEYS_ESCALATION',
            'Scope update would escalate privileges; pass allowEscalation to override',
            { status: 403, expose: true },
          );
        }
        record.scopes = scopes;
      }
      if (input.metadata !== undefined) record.metadata = assertMetadata(input.metadata);
      if (input.rateLimit !== undefined) record.rateLimit = input.rateLimit;
      if (input.rateLimitWindowMs !== undefined) record.rateLimitWindowMs = input.rateLimitWindowMs;
      record.updatedAt = clock.now();
      await options.store.updateKey(record);
      await invalidate(record.publicId);
      return toApiKey(record);
    },

    async rotate(id, input = {}) {
      const record = await options.store.getKeyById(id);
      if (!record) throw notFound('api_key', id);
      if (record.status !== 'active') {
        throw new ApiKeysError('API_KEYS_REVOKED', 'Only active keys can be rotated', {
          status: 409,
          expose: true,
        });
      }
      const grace = input.gracePeriodMs ?? DAY;
      if (!Number.isFinite(grace) || grace < 0) {
        throw argumentError('gracePeriodMs', 'must be >= 0');
      }
      const now = clock.now();
      const rebuilt = rebuildKeyWithPublicId(record.prefix, record.publicId);
      record.previousKeyHash = grace === 0 ? null : record.keyHash;
      record.previousExpiresAt = grace === 0 ? null : now + Math.floor(grace);
      record.keyHash = hashKey(pepper, rebuilt.key);
      record.displayPrefix = rebuilt.displayPrefix;
      record.updatedAt = now;
      await options.store.updateKey(record);
      await invalidate(record.publicId);
      await audit('api_keys.rotated', 'success', record.id, {
        gracePeriodMs: grace,
        publicId: record.publicId,
      });
      return { key: toApiKey(record), secret: rebuilt.key };
    },

    async revoke(id, input = {}) {
      const record = await options.store.getKeyById(id);
      if (!record) throw notFound('api_key', id);
      const now = clock.now();
      record.status = 'revoked';
      record.revokedAt = now;
      record.revokedReason = input.reason ?? 'revoked';
      record.revokedBy = input.actor ?? null;
      record.previousKeyHash = null;
      record.previousExpiresAt = null;
      record.updatedAt = now;
      await options.store.updateKey(record);
      await invalidate(record.publicId);
      await audit('api_keys.revoked', 'success', record.id, {
        reason: record.revokedReason,
        actor: record.revokedBy,
      });
      return toApiKey(record);
    },

    async verify(rawKey, verifyOptions = {}) {
      const fail = async (
        code: VerifyFailure['code'],
        status: VerifyFailure['status'],
        retryAfterMs?: number,
      ): Promise<VerifyFailure> => {
        if (sampleRate > 0 && randomBytes(1)[0]! / 255 < sampleRate) {
          await audit('api_keys.verification_failed', 'failure', undefined, { code });
        }
        const out: VerifyFailure = { ok: false, code, status };
        if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
        return out;
      };

      const parsed = parseKey(rawKey, prefix);
      if (!parsed) {
        dummyHashCompare(pepper);
        return fail('API_KEYS_UNAUTHORIZED', 401);
      }
      const record = await loadByPublicId(parsed.publicId);
      if (!record) {
        dummyHashCompare(pepper);
        return fail('API_KEYS_UNAUTHORIZED', 401);
      }
      const presented = hashKey(pepper, parsed.key);
      const primaryOk = hashesEqual(presented, record.keyHash);
      let graceOk = false;
      const now = clock.now();
      if (
        !primaryOk &&
        record.previousKeyHash &&
        record.previousExpiresAt !== null &&
        record.previousExpiresAt > now
      ) {
        graceOk = hashesEqual(presented, record.previousKeyHash);
      }
      if (!primaryOk && !graceOk) {
        dummyHashCompare(pepper);
        return fail('API_KEYS_UNAUTHORIZED', 401);
      }
      if (record.status === 'revoked') return fail('API_KEYS_UNAUTHORIZED', 401);
      if (record.status === 'expired' || (record.expiresAt !== null && record.expiresAt <= now)) {
        return fail('API_KEYS_UNAUTHORIZED', 401);
      }
      if (record.ownerType === 'service_account') {
        const sa = await options.store.getServiceAccount(record.ownerId);
        if (!sa || !sa.enabled) return fail('API_KEYS_UNAUTHORIZED', 401);
      }
      if (verifyOptions.scopes && verifyOptions.scopes.length > 0) {
        if (!hasAllScopes(record.scopes, verifyOptions.scopes)) {
          return fail('API_KEYS_SCOPE_DENIED', 403);
        }
      }
      if (record.rateLimit && record.rateLimitWindowMs && options.rateLimiter) {
        const decision = await options.rateLimiter.consume(`apikey:${record.publicId}`, 1);
        if (!decision.allowed) {
          return fail('API_KEYS_RATE_LIMITED', 429, decision.retryAfterMs);
        }
      }
      if (!verifyOptions.skipUsage) {
        usage.record(record.publicId, now, verifyOptions.ip ?? null);
      }
      return {
        ok: true,
        principal: {
          type: 'api_key',
          id: record.id,
          keyId: record.id,
          publicId: record.publicId,
          scopes: [...record.scopes],
          ownerType: record.ownerType,
          ownerId: record.ownerId,
          orgId: record.orgId,
          name: record.name,
          metadata: { ...record.metadata },
        },
        record,
      };
    },

    async createServiceAccount(input) {
      const now = clock.now();
      const record: ServiceAccountRecord = {
        id: generateId(),
        name: assertName(input.name),
        description: input.description ?? null,
        orgId: input.orgId ?? null,
        metadata: assertMetadata(input.metadata),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      await options.store.insertServiceAccount(record);
      return toServiceAccount(record);
    },

    async getServiceAccount(id) {
      const record = await options.store.getServiceAccount(id);
      if (!record) throw notFound('service_account', id);
      return toServiceAccount(record);
    },

    async listServiceAccounts(query = {}) {
      const page = await options.store.listServiceAccounts(query);
      return { ...page, items: page.items.map(toServiceAccount) };
    },

    async updateServiceAccount(id, input) {
      const record = await options.store.getServiceAccount(id);
      if (!record) throw notFound('service_account', id);
      if (input.name !== undefined) record.name = assertName(input.name);
      if (input.description !== undefined) record.description = input.description;
      if (input.metadata !== undefined) record.metadata = assertMetadata(input.metadata);
      if (input.enabled !== undefined) {
        record.enabled = input.enabled;
        record.disabledAt = input.enabled ? null : clock.now();
      }
      record.updatedAt = clock.now();
      await options.store.updateServiceAccount(record);
      if (input.enabled === false && options.cache) {
        const keys = await options.store.listKeys(
          { ownerType: 'service_account', ownerId: id, limit: 200 },
          clock.now(),
        );
        for (const k of keys.items) await invalidate(k.publicId);
      }
      return toServiceAccount(record);
    },

    async deleteServiceAccount(id) {
      const keys = await options.store.listKeys(
        { ownerType: 'service_account', ownerId: id, limit: 1 },
        clock.now(),
      );
      if (keys.items.length > 0) {
        throw new ApiKeysError(
          'API_KEYS_CONFLICT',
          'Revoke or delete keys before deleting the service account',
          { status: 409, expose: true },
        );
      }
      const ok = await options.store.deleteServiceAccount(id);
      if (!ok) throw notFound('service_account', id);
    },

    async shutdown() {
      await usage.shutdown();
    },
  };

  return service;
}
