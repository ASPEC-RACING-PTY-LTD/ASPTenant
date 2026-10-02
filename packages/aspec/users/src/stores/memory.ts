import { UsersError } from '../errors.js';
import {
  type AscPosition,
  type StoreActivityQuery,
  type StoreInvitationQuery,
  type StoreUserQuery,
  searchText,
  type UsersStore,
} from '../store.js';
import type { ActivationTokenRecord, ActivityEvent, InvitationRecord, User } from '../types.js';

export interface MemoryUsersStoreOptions {
  /** Maximum number of accounts. Default 100000. */
  maxUsers?: number;
  /** Maximum stored activity events per user; the oldest are dropped. Default 1000. */
  maxActivityPerUser?: number;
  /** Maximum number of invitations. Default 100000. */
  maxInvitations?: number;
}

function afterAsc(item: { createdAt: number; id: string }, pos: AscPosition | undefined): boolean {
  if (!pos) return true;
  return item.createdAt > pos.createdAt || (item.createdAt === pos.createdAt && item.id > pos.id);
}

function compareAsc(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function compareDesc(a: ActivityEvent, b: ActivityEvent) {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * In-memory store for tests, prototypes and single-process deployments. Data is lost on
 * restart. Every read returns a copy.
 */
export function createMemoryUsersStore(options: MemoryUsersStoreOptions = {}): UsersStore {
  const maxUsers = options.maxUsers ?? 100_000;
  const maxActivity = options.maxActivityPerUser ?? 1000;
  const maxInvitations = options.maxInvitations ?? 100_000;
  const users = new Map<string, User>();
  const byEmail = new Map<string, string>();
  const byExternal = new Map<string, string>();
  const tokens = new Map<string, ActivationTokenRecord>();
  const invitations = new Map<string, InvitationRecord>();
  const activity = new Map<string, ActivityEvent[]>();

  const extKey = (provider: string | null, id: string | null) =>
    provider !== null && id !== null ? `${provider}\u0000${id}` : null;

  const checkUnique = (user: User, existingId: string | null) => {
    const emailOwner = byEmail.get(user.email);
    if (emailOwner !== undefined && emailOwner !== existingId) {
      throw new UsersError('USERS_EMAIL_TAKEN', 'A user with this email already exists');
    }
    const key = extKey(user.authProvider, user.externalId);
    if (key !== null) {
      const owner = byExternal.get(key);
      if (owner !== undefined && owner !== existingId) {
        throw new UsersError(
          'USERS_EXTERNAL_ID_TAKEN',
          'This external identity is linked to another user',
        );
      }
    }
  };

  const index = (user: User) => {
    byEmail.set(user.email, user.id);
    const key = extKey(user.authProvider, user.externalId);
    if (key !== null) byExternal.set(key, user.id);
  };

  const unindex = (user: User) => {
    if (byEmail.get(user.email) === user.id) byEmail.delete(user.email);
    const key = extKey(user.authProvider, user.externalId);
    if (key !== null && byExternal.get(key) === user.id) byExternal.delete(key);
  };

  const copy = <T>(value: T): T => structuredClone(value);

  return {
    async insertUser(user) {
      if (users.has(user.id)) throw new UsersError('USERS_ID_TAKEN', 'User ID already exists');
      checkUnique(user, null);
      if (users.size >= maxUsers) {
        throw new UsersError('USERS_STORE_LIMIT', 'Memory store user limit reached');
      }
      users.set(user.id, copy(user));
      index(user);
    },
    async getUser(id) {
      const u = users.get(id);
      return u ? copy(u) : null;
    },
    async getUserByEmail(email) {
      const id = byEmail.get(email);
      const u = id === undefined ? undefined : users.get(id);
      return u ? copy(u) : null;
    },
    async getUserByExternalId(provider, externalId) {
      const id = byExternal.get(`${provider}\u0000${externalId}`);
      const u = id === undefined ? undefined : users.get(id);
      return u ? copy(u) : null;
    },
    async updateUser(user, expectedVersion) {
      const current = users.get(user.id);
      if (!current || current.version !== expectedVersion) return false;
      checkUnique(user, user.id);
      unindex(current);
      users.set(user.id, copy(user));
      index(user);
      return true;
    },
    async deleteUser(id) {
      const current = users.get(id);
      if (!current) return false;
      unindex(current);
      users.delete(id);
      activity.delete(id);
      for (const [tid, t] of tokens) if (t.userId === id) tokens.delete(tid);
      return true;
    },
    async listUsers(query: StoreUserQuery) {
      const out: User[] = [];
      const sorted = [...users.values()].sort(compareAsc);
      for (const u of sorted) {
        if (!afterAsc(u, query.after)) continue;
        if (query.status && u.status !== query.status) continue;
        if (query.search && !searchText(u).includes(query.search)) continue;
        out.push(copy(u));
        if (out.length >= query.limit) break;
      }
      return out;
    },
    async listDueForPurge(now, limit) {
      return [...users.values()]
        .filter(
          (u) =>
            u.status === 'deleted' &&
            u.purgedAt === null &&
            u.deletion !== null &&
            u.deletion.purgeAfter <= now,
        )
        .sort(compareAsc)
        .slice(0, limit)
        .map(copy);
    },
    async listExpiredSuspensions(now, limit) {
      return [...users.values()]
        .filter(
          (u) =>
            u.status === 'suspended' &&
            u.suspension !== null &&
            u.suspension.until !== null &&
            u.suspension.until <= now,
        )
        .sort(compareAsc)
        .slice(0, limit)
        .map(copy);
    },

    async insertActivationToken(record) {
      tokens.set(record.id, copy(record));
    },
    async getActivationToken(id) {
      const t = tokens.get(id);
      return t ? copy(t) : null;
    },
    async markActivationTokenUsed(id, usedAt) {
      const t = tokens.get(id);
      if (!t || t.usedAt !== null) return false;
      t.usedAt = usedAt;
      return true;
    },
    async listActivationTokens(userId) {
      return [...tokens.values()]
        .filter((t) => t.userId === userId)
        .sort(compareAsc)
        .map(copy);
    },
    async deleteActivationTokens(userId) {
      for (const [id, t] of tokens) if (t.userId === userId) tokens.delete(id);
    },

    async insertInvitation(record) {
      if (invitations.has(record.id)) {
        throw new UsersError('USERS_INVITATION_EXISTS', 'Invitation ID already exists');
      }
      for (const inv of invitations.values()) {
        if (inv.status === 'pending' && inv.email === record.email && record.status === 'pending') {
          throw new UsersError(
            'USERS_INVITATION_EXISTS',
            'A pending invitation exists for this email',
          );
        }
      }
      if (invitations.size >= maxInvitations) {
        throw new UsersError('USERS_STORE_LIMIT', 'Memory store invitation limit reached');
      }
      invitations.set(record.id, copy(record));
    },
    async getInvitation(id) {
      const i = invitations.get(id);
      return i ? copy(i) : null;
    },
    async findPendingInvitation(email) {
      for (const inv of invitations.values()) {
        if (inv.status === 'pending' && inv.email === email) return copy(inv);
      }
      return null;
    },
    async updateInvitation(record, expectedVersion) {
      const current = invitations.get(record.id);
      if (!current || current.version !== expectedVersion) return false;
      invitations.set(record.id, copy(record));
      return true;
    },
    async listInvitations(query: StoreInvitationQuery) {
      const out: InvitationRecord[] = [];
      for (const inv of [...invitations.values()].sort(compareAsc)) {
        if (!afterAsc(inv, query.after)) continue;
        if (query.status && inv.status !== query.status) continue;
        if (query.email && inv.email !== query.email) continue;
        out.push(copy(inv));
        if (out.length >= query.limit) break;
      }
      return out;
    },
    async deleteInvitationsByEmail(email) {
      let n = 0;
      for (const [id, inv] of invitations) {
        if (inv.email === email) {
          invitations.delete(id);
          n++;
        }
      }
      return n;
    },

    async appendActivity(event) {
      let list = activity.get(event.userId);
      if (!list) {
        list = [];
        activity.set(event.userId, list);
      }
      list.push(copy(event));
      list.sort(compareDesc);
      if (list.length > maxActivity) list.length = maxActivity;
    },
    async listActivity(userId, query: StoreActivityQuery) {
      const list = activity.get(userId) ?? [];
      const out: ActivityEvent[] = [];
      for (const e of list) {
        if (query.before) {
          const b = query.before;
          if (!(e.at < b.at || (e.at === b.at && e.id < b.id))) continue;
        }
        if (query.type && e.type !== query.type) continue;
        out.push(copy(e));
        if (out.length >= query.limit) break;
      }
      return out;
    },
    async pruneActivity(before) {
      let n = 0;
      for (const [userId, list] of activity) {
        const kept = list.filter((e) => e.at >= before);
        n += list.length - kept.length;
        if (kept.length === 0) activity.delete(userId);
        else activity.set(userId, kept);
      }
      return n;
    },
    async deleteActivity(userId) {
      const n = activity.get(userId)?.length ?? 0;
      activity.delete(userId);
      return n;
    },
  };
}
