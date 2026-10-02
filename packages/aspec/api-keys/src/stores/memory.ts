import { ApiKeysError } from '../errors.js';
import type { ApiKeysStore } from '../store.js';
import type {
  ApiKeyRecord,
  KeyListQuery,
  Page,
  ServiceAccountListQuery,
  ServiceAccountRecord,
} from '../types.js';

export interface MemoryStoreOptions {
  /** Maximum key records. Default 100_000. */
  maxKeys?: number;
  /** Maximum service accounts. Default 10_000. */
  maxServiceAccounts?: number;
}

function cloneKey(r: ApiKeyRecord): ApiKeyRecord {
  return { ...r, scopes: [...r.scopes], metadata: { ...r.metadata } };
}

function cloneSa(r: ServiceAccountRecord): ServiceAccountRecord {
  return { ...r, metadata: { ...r.metadata } };
}

function decodeCursor(cursor: string | undefined): { createdAt: number; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAt, id] = raw.split('\n');
    if (!createdAt || !id) return undefined;
    const n = Number(createdAt);
    if (!Number.isFinite(n)) return undefined;
    return { createdAt: n, id };
  } catch {
    return undefined;
  }
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, 'utf8').toString('base64url');
}

export function createMemoryStore(options: MemoryStoreOptions = {}): ApiKeysStore & {
  clear(): void;
} {
  const maxKeys = options.maxKeys ?? 100_000;
  const maxServiceAccounts = options.maxServiceAccounts ?? 10_000;
  const keysById = new Map<string, ApiKeyRecord>();
  const keysByPublicId = new Map<string, string>();
  const accounts = new Map<string, ServiceAccountRecord>();

  const store: ApiKeysStore & { clear(): void } = {
    async insertKey(record) {
      if (keysById.size >= maxKeys) {
        throw new ApiKeysError('API_KEYS_CONFLICT', 'Key store capacity exceeded', { status: 507 });
      }
      if (keysById.has(record.id) || keysByPublicId.has(record.publicId)) {
        throw new ApiKeysError('API_KEYS_CONFLICT', 'Key already exists', { status: 409 });
      }
      const copy = cloneKey(record);
      keysById.set(copy.id, copy);
      keysByPublicId.set(copy.publicId, copy.id);
    },
    async updateKey(record) {
      const existing = keysById.get(record.id);
      if (!existing) throw new ApiKeysError('API_KEYS_NOT_FOUND', 'Key not found', { status: 404 });
      const copy = cloneKey(record);
      keysById.set(copy.id, copy);
      keysByPublicId.set(copy.publicId, copy.id);
    },
    async getKeyById(id) {
      const r = keysById.get(id);
      return r ? cloneKey(r) : undefined;
    },
    async getKeyByPublicId(publicId) {
      const id = keysByPublicId.get(publicId);
      if (!id) return undefined;
      const r = keysById.get(id);
      return r ? cloneKey(r) : undefined;
    },
    async listKeys(query, now) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const cursor = decodeCursor(query.cursor);
      let items = [...keysById.values()];
      if (query.status) items = items.filter((k) => k.status === query.status);
      if (query.ownerType) items = items.filter((k) => k.ownerType === query.ownerType);
      if (query.ownerId) items = items.filter((k) => k.ownerId === query.ownerId);
      if (query.orgId) items = items.filter((k) => k.orgId === query.orgId);
      if (query.scope) {
        const scope = query.scope;
        items = items.filter((k) => k.scopes.includes(scope));
      }
      if (query.expiringWithinDays !== undefined) {
        const until = now + query.expiringWithinDays * 86_400_000;
        items = items.filter(
          (k) => k.expiresAt !== null && k.expiresAt <= until && k.status === 'active',
        );
      }
      if (query.q) {
        const q = query.q.toLowerCase();
        items = items.filter(
          (k) => k.name.toLowerCase().includes(q) || k.publicId.toLowerCase().includes(q),
        );
      }
      items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
      if (cursor) {
        items = items.filter(
          (k) =>
            k.createdAt < cursor.createdAt ||
            (k.createdAt === cursor.createdAt && k.id > cursor.id),
        );
      }
      const page = items.slice(0, limit);
      const next =
        items.length > limit
          ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
          : null;
      return { items: page.map(cloneKey), nextCursor: next, total: items.length };
    },
    async deleteKey(id) {
      const existing = keysById.get(id);
      if (!existing) return false;
      keysById.delete(id);
      keysByPublicId.delete(existing.publicId);
      return true;
    },
    async insertServiceAccount(record) {
      if (accounts.size >= maxServiceAccounts) {
        throw new ApiKeysError('API_KEYS_CONFLICT', 'Service account capacity exceeded', {
          status: 507,
        });
      }
      if (accounts.has(record.id)) {
        throw new ApiKeysError('API_KEYS_CONFLICT', 'Service account already exists', {
          status: 409,
        });
      }
      accounts.set(record.id, cloneSa(record));
    },
    async updateServiceAccount(record) {
      if (!accounts.has(record.id)) {
        throw new ApiKeysError('API_KEYS_NOT_FOUND', 'Service account not found', { status: 404 });
      }
      accounts.set(record.id, cloneSa(record));
    },
    async getServiceAccount(id) {
      const r = accounts.get(id);
      return r ? cloneSa(r) : undefined;
    },
    async listServiceAccounts(query) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const cursor = decodeCursor(query.cursor);
      let items = [...accounts.values()];
      if (query.orgId) items = items.filter((a) => a.orgId === query.orgId);
      if (query.enabled !== undefined) items = items.filter((a) => a.enabled === query.enabled);
      if (query.q) {
        const q = query.q.toLowerCase();
        items = items.filter((a) => a.name.toLowerCase().includes(q));
      }
      items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
      if (cursor) {
        items = items.filter(
          (a) =>
            a.createdAt < cursor.createdAt ||
            (a.createdAt === cursor.createdAt && a.id > cursor.id),
        );
      }
      const page = items.slice(0, limit);
      const next =
        items.length > limit
          ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id)
          : null;
      return { items: page.map(cloneSa), nextCursor: next };
    },
    async deleteServiceAccount(id) {
      return accounts.delete(id);
    },
    async applyUsage(deltas) {
      for (const d of deltas) {
        const id = keysByPublicId.get(d.publicId);
        if (!id) continue;
        const key = keysById.get(id);
        if (!key) continue;
        key.useCount += d.increment;
        if (key.lastUsedAt === null || d.lastUsedAt >= key.lastUsedAt) {
          key.lastUsedAt = d.lastUsedAt;
          key.lastUsedIp = d.lastUsedIp;
        }
        key.updatedAt = Math.max(key.updatedAt, d.lastUsedAt);
      }
    },
    async markExpired(now) {
      let n = 0;
      for (const key of keysById.values()) {
        if (key.status === 'active' && key.expiresAt !== null && key.expiresAt <= now) {
          key.status = 'expired';
          key.updatedAt = now;
          n++;
        }
      }
      return n;
    },
    clear() {
      keysById.clear();
      keysByPublicId.clear();
      accounts.clear();
    },
  };
  return store;
}

export type { KeyListQuery, Page, ServiceAccountListQuery };
