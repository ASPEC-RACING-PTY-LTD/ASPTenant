import type {
  ApiKeyRecord,
  KeyListQuery,
  KeyStatus,
  Page,
  ServiceAccountListQuery,
  ServiceAccountRecord,
  UsageDelta,
} from './types.js';

export interface ApiKeysStore {
  insertKey(record: ApiKeyRecord): Promise<void>;
  updateKey(record: ApiKeyRecord): Promise<void>;
  getKeyById(id: string): Promise<ApiKeyRecord | undefined>;
  getKeyByPublicId(publicId: string): Promise<ApiKeyRecord | undefined>;
  listKeys(query: KeyListQuery, now: number): Promise<Page<ApiKeyRecord>>;
  deleteKey(id: string): Promise<boolean>;

  insertServiceAccount(record: ServiceAccountRecord): Promise<void>;
  updateServiceAccount(record: ServiceAccountRecord): Promise<void>;
  getServiceAccount(id: string): Promise<ServiceAccountRecord | undefined>;
  listServiceAccounts(query: ServiceAccountListQuery): Promise<Page<ServiceAccountRecord>>;
  deleteServiceAccount(id: string): Promise<boolean>;

  /** Applies batched usage increments. */
  applyUsage(deltas: readonly UsageDelta[]): Promise<void>;

  /** Marks expired active keys. */
  markExpired(now: number): Promise<number>;

  /** Optional transactional helper. */
  transaction?<T>(fn: (tx: ApiKeysStore) => Promise<T>): Promise<T>;
}

export type { KeyStatus };
