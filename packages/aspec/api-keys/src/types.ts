export type KeyStatus = 'active' | 'revoked' | 'expired';

export type OwnerType = 'user' | 'service_account';

export interface ApiKeyRecord {
  id: string;
  publicId: string;
  /** HMAC-SHA256(pepper, plaintext). Never log or return. */
  keyHash: string;
  displayPrefix: string;
  prefix: string;
  name: string;
  scopes: string[];
  status: KeyStatus;
  ownerType: OwnerType;
  ownerId: string;
  orgId: string | null;
  metadata: Record<string, unknown>;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
  revokedBy: string | null;
  /** Previous key hash still accepted during rotation grace. */
  previousKeyHash: string | null;
  previousExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  useCount: number;
  /** Optional per-key rate limit (requests per window). */
  rateLimit: number | null;
  rateLimitWindowMs: number | null;
}

/** Safe view returned to clients (never includes hashes). */
export interface ApiKey {
  id: string;
  publicId: string;
  displayPrefix: string;
  name: string;
  scopes: string[];
  status: KeyStatus;
  ownerType: OwnerType;
  ownerId: string;
  orgId: string | null;
  metadata: Record<string, unknown>;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  useCount: number;
  rateLimit: number | null;
  rateLimitWindowMs: number | null;
}

export interface CreatedApiKey {
  key: ApiKey;
  /** Plaintext secret. Shown once; never stored. */
  secret: string;
}

export interface ServiceAccountRecord {
  id: string;
  name: string;
  description: string | null;
  orgId: string | null;
  metadata: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
}

export interface ServiceAccount {
  id: string;
  name: string;
  description: string | null;
  orgId: string | null;
  metadata: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface KeyListQuery {
  cursor?: string;
  limit?: number;
  status?: KeyStatus;
  ownerType?: OwnerType;
  ownerId?: string;
  orgId?: string;
  scope?: string;
  /** Keys expiring within this many days (inclusive). */
  expiringWithinDays?: number;
  q?: string;
}

export interface ServiceAccountListQuery {
  cursor?: string;
  limit?: number;
  orgId?: string;
  enabled?: boolean;
  q?: string;
}

export interface UsageDelta {
  publicId: string;
  lastUsedAt: number;
  lastUsedIp: string | null;
  increment: number;
}

export interface VerifiedPrincipal {
  type: 'api_key';
  id: string;
  keyId: string;
  publicId: string;
  scopes: string[];
  ownerType: OwnerType;
  ownerId: string;
  orgId: string | null;
  name: string;
  metadata: Record<string, unknown>;
}

export function toApiKey(record: ApiKeyRecord): ApiKey {
  return {
    id: record.id,
    publicId: record.publicId,
    displayPrefix: record.displayPrefix,
    name: record.name,
    scopes: [...record.scopes],
    status: record.status,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    orgId: record.orgId,
    metadata: { ...record.metadata },
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
    lastUsedIp: record.lastUsedIp,
    useCount: record.useCount,
    rateLimit: record.rateLimit,
    rateLimitWindowMs: record.rateLimitWindowMs,
  };
}

export function toServiceAccount(record: ServiceAccountRecord): ServiceAccount {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    orgId: record.orgId,
    metadata: { ...record.metadata },
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabledAt: record.disabledAt,
  };
}
