import type {
  ActivationTokenRecord,
  ActivityEvent,
  InvitationRecord,
  InvitationStatus,
  User,
  UserStatus,
} from './types.js';

/** Keyset position for ascending lists ordered by (createdAt, id). */
export interface AscPosition {
  createdAt: number;
  id: string;
}

/** Keyset position for activity lists ordered by (at, id) descending. */
export interface DescPosition {
  at: number;
  id: string;
}

export interface StoreUserQuery {
  status?: UserStatus;
  /** Lowercased search term; matches email or display name substrings. */
  search?: string;
  after?: AscPosition;
  limit: number;
}

export interface StoreInvitationQuery {
  status?: InvitationStatus;
  email?: string;
  after?: AscPosition;
  limit: number;
}

export interface StoreActivityQuery {
  type?: string;
  before?: DescPosition;
  limit: number;
}

/**
 * Persistence port for @aspec/users. Implementations: `createMemoryUsersStore` (./memory)
 * and `createSqlUsersStore` (./sql). Custom stores must pass the same contract tests.
 *
 * Uniqueness violations are reported by throwing a `UsersError` with code
 * `USERS_EMAIL_TAKEN`, `USERS_ID_TAKEN` or `USERS_EXTERNAL_ID_TAKEN`.
 */
export interface UsersStore {
  insertUser(user: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByExternalId(authProvider: string, externalId: string): Promise<User | null>;
  /** Writes `user` if the stored version equals `expectedVersion`; returns false otherwise. */
  updateUser(user: User, expectedVersion: number): Promise<boolean>;
  /** Hard deletes the account row with its activation tokens and activity events. */
  deleteUser(id: string): Promise<boolean>;
  listUsers(query: StoreUserQuery): Promise<User[]>;
  /** Users with status `deleted`, not yet purged, and `deletion.purgeAfter <= now`. */
  listDueForPurge(now: number, limit: number): Promise<User[]>;
  /** Suspended users whose `suspension.until <= now`. */
  listExpiredSuspensions(now: number, limit: number): Promise<User[]>;

  insertActivationToken(record: ActivationTokenRecord): Promise<void>;
  getActivationToken(id: string): Promise<ActivationTokenRecord | null>;
  /** Marks the token used if it is unused; returns false when it was already used. */
  markActivationTokenUsed(id: string, usedAt: number): Promise<boolean>;
  listActivationTokens(userId: string): Promise<ActivationTokenRecord[]>;
  deleteActivationTokens(userId: string): Promise<void>;

  insertInvitation(record: InvitationRecord): Promise<void>;
  getInvitation(id: string): Promise<InvitationRecord | null>;
  /** The invitation with status `pending` for the email (expired or not), if any. */
  findPendingInvitation(email: string): Promise<InvitationRecord | null>;
  updateInvitation(record: InvitationRecord, expectedVersion: number): Promise<boolean>;
  listInvitations(query: StoreInvitationQuery): Promise<InvitationRecord[]>;
  deleteInvitationsByEmail(email: string): Promise<number>;

  appendActivity(event: ActivityEvent): Promise<void>;
  listActivity(userId: string, query: StoreActivityQuery): Promise<ActivityEvent[]>;
  /** Deletes events with `at < before`; returns the number deleted. */
  pruneActivity(before: number): Promise<number>;
  deleteActivity(userId: string): Promise<number>;
}

/** Lowercased text used for `search` matching. */
export function searchText(user: User): string {
  return `${user.email} ${user.profile.displayName ?? ''}`.toLowerCase();
}
