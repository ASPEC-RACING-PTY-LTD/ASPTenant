export const USER_STATUSES = ['pending', 'active', 'suspended', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserProfile {
  displayName: string | null;
  avatarUrl: string | null;
  /** Canonical BCP 47 language tag, for example `en-GB`. */
  locale: string | null;
  /** IANA time zone, for example `Europe/London`. */
  timezone: string | null;
  bio: string | null;
  /** Application-defined custom profile fields (validated by `profileFields`). */
  fields: Record<string, unknown>;
}

export interface Suspension {
  reason: string;
  actorId: string | null;
  suspendedAt: number;
  /** Epoch ms when the suspension ends automatically, or null for indefinite. */
  until: number | null;
  /** Status to restore on reactivation. */
  previousStatus: 'pending' | 'active';
}

export interface DeletionRequest {
  requestedAt: number;
  /** Epoch ms after which the account can be purged. */
  purgeAfter: number;
  actorId: string | null;
  reason: string | null;
  /** Status to restore when the deletion is cancelled. */
  previousStatus: 'pending' | 'active' | 'suspended';
}

export interface User {
  id: string;
  /** Normalised (trimmed, lowercased) unique email address. */
  email: string;
  status: UserStatus;
  /** Subject identifier at an external identity provider or auth system. */
  externalId: string | null;
  /** Name of the provider that issued `externalId`, for example `aspec-auth` or `okta`. */
  authProvider: string | null;
  profile: UserProfile;
  /** Stored account setting values (defaults are applied by `getSettings`). */
  settings: Record<string, unknown>;
  /** Stored preference overrides (defaults are applied by `getPreferences`). */
  preferences: Record<string, unknown>;
  /** Application metadata (for example invitation roles). Not user editable. */
  metadata: Record<string, unknown>;
  suspension: Suspension | null;
  deletion: DeletionRequest | null;
  createdAt: number;
  updatedAt: number;
  activatedAt: number | null;
  lastLoginAt: number | null;
  purgedAt: number | null;
  /** Optimistic concurrency version, incremented on every update. */
  version: number;
}

export interface ActivationTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface Invitation {
  id: string;
  email: string;
  status: InvitationStatus;
  roles: string[];
  metadata: Record<string, unknown>;
  invitedBy: string | null;
  userId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  lastSentAt: number | null;
  sendCount: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  version: number;
}

/** Stored invitation, including the token hash that is never returned by the service. */
export interface InvitationRecord extends Invitation {
  tokenHash: string;
}

export interface ActivityEvent {
  id: string;
  userId: string;
  /** Namespaced type, for example `login`, `profile.updated`, `status.changed`. */
  type: string;
  at: number;
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when there are no more items. */
  nextCursor: string | null;
}

export interface UserListQuery {
  status?: UserStatus;
  /** Case-insensitive substring match on email and display name. */
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface InvitationListQuery {
  status?: InvitationStatus;
  email?: string;
  cursor?: string;
  limit?: number;
}

export interface ActivityListQuery {
  type?: string;
  cursor?: string;
  limit?: number;
}

/** Who performs an action, for audit events and activity history. */
export interface Actor {
  id: string;
  type?: string;
  ip?: string;
  userAgent?: string;
}

export interface ActionContext {
  actor?: Actor;
  requestId?: string;
  tenantId?: string;
}
