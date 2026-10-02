import { OrgsError } from '../errors.js';
import type {
  AscPosition,
  OrgsStore,
  StoreInvitationQuery,
  StoreMemberQuery,
  StoreOrgQuery,
} from '../store.js';
import type {
  InvitationRecord,
  Membership,
  Organisation,
  Team,
  TeamMembership,
  TenantRecord,
} from '../types.js';

export interface MemoryOrgsStoreOptions {
  maxOrgs?: number;
  maxMembers?: number;
  maxTeams?: number;
  maxInvitations?: number;
}

function afterAsc(item: { createdAt: number; id: string }, pos: AscPosition | undefined): boolean {
  if (!pos) return true;
  return item.createdAt > pos.createdAt || (item.createdAt === pos.createdAt && item.id > pos.id);
}

function compareAsc(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function createMemoryOrgsStore(options: MemoryOrgsStoreOptions = {}): OrgsStore {
  const maxOrgs = options.maxOrgs ?? 100_000;
  const maxMembers = options.maxMembers ?? 1_000_000;
  const maxTeams = options.maxTeams ?? 100_000;
  const maxInvitations = options.maxInvitations ?? 100_000;

  const orgs = new Map<string, Organisation>();
  const orgsBySlug = new Map<string, string>();
  const membersById = new Map<string, Membership>();
  const membersByKey = new Map<string, string>();
  const memberKey = (orgId: string, userId: string) => `${orgId}\0${userId}`;
  const teams = new Map<string, Team>();
  const teamsBySlug = new Map<string, string>();
  const teamSlugKey = (orgId: string, slug: string) => `${orgId}\0${slug}`;
  const teamMembersById = new Map<string, TeamMembership>();
  const teamMembersByKey = new Map<string, string>();
  const teamMemberKey = (teamId: string, userId: string) => `${teamId}\0${userId}`;
  const invitations = new Map<string, InvitationRecord>();
  const tenants = new Map<string, TenantRecord>();

  return {
    async insertOrg(org) {
      if (orgs.size >= maxOrgs)
        throw new OrgsError('ORGS_STORE_LIMIT', 'Organisation limit reached');
      if (orgs.has(org.id)) throw new OrgsError('ORGS_ID_TAKEN', 'Organisation id already exists');
      if (orgsBySlug.has(org.slug)) throw new OrgsError('ORGS_SLUG_TAKEN', 'Slug already taken');
      orgs.set(org.id, clone(org));
      orgsBySlug.set(org.slug, org.id);
      return clone(org);
    },
    async updateOrg(org, expectedVersion) {
      const cur = orgs.get(org.id);
      if (!cur) throw new OrgsError('ORGS_NOT_FOUND', 'Organisation not found');
      if (cur.version !== expectedVersion) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Organisation version conflict');
      }
      if (cur.slug !== org.slug) {
        if (orgsBySlug.has(org.slug)) throw new OrgsError('ORGS_SLUG_TAKEN', 'Slug already taken');
        orgsBySlug.delete(cur.slug);
        orgsBySlug.set(org.slug, org.id);
      }
      const next = { ...clone(org), version: cur.version + 1 };
      orgs.set(org.id, next);
      return clone(next);
    },
    async getOrg(id) {
      const o = orgs.get(id);
      return o ? clone(o) : null;
    },
    async getOrgBySlug(slug) {
      const id = orgsBySlug.get(slug);
      if (!id) return null;
      const o = orgs.get(id);
      return o ? clone(o) : null;
    },
    async listOrgs(query: StoreOrgQuery) {
      let list = [...orgs.values()];
      if (query.status) list = list.filter((o) => o.status === query.status);
      if (query.search) {
        const q = query.search.toLowerCase();
        list = list.filter(
          (o) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q),
        );
      }
      return list
        .filter((o) => afterAsc(o, query.after))
        .sort(compareAsc)
        .slice(0, query.limit)
        .map(clone);
    },

    async insertMembership(m) {
      if (membersById.size >= maxMembers) {
        throw new OrgsError('ORGS_STORE_LIMIT', 'Membership limit');
      }
      const key = memberKey(m.orgId, m.userId);
      if (membersById.has(m.id) || membersByKey.has(key)) {
        throw new OrgsError('ORGS_MEMBER_EXISTS', 'Membership already exists');
      }
      membersById.set(m.id, clone(m));
      membersByKey.set(key, m.id);
      return clone(m);
    },
    async updateMembership(m, expectedVersion) {
      const cur = membersById.get(m.id);
      if (!cur) throw new OrgsError('ORGS_MEMBER_NOT_FOUND', 'Membership not found');
      if (cur.version !== expectedVersion) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Membership version conflict');
      }
      const next = { ...clone(m), version: cur.version + 1 };
      membersById.set(m.id, next);
      membersByKey.set(memberKey(m.orgId, m.userId), m.id);
      return clone(next);
    },
    async getMembership(orgId, userId) {
      const id = membersByKey.get(memberKey(orgId, userId));
      if (!id) return null;
      const m = membersById.get(id);
      return m ? clone(m) : null;
    },
    async getMembershipById(id) {
      const m = membersById.get(id);
      return m ? clone(m) : null;
    },
    async listMemberships(query: StoreMemberQuery) {
      return [...membersById.values()]
        .filter((m) => m.orgId === query.orgId)
        .filter((m) => (query.status ? m.status === query.status : true))
        .filter((m) => afterAsc(m, query.after))
        .sort(compareAsc)
        .slice(0, query.limit)
        .map(clone);
    },
    async listMembershipsForUser(userId) {
      return [...membersById.values()]
        .filter((m) => m.userId === userId && m.status !== 'removed')
        .map(clone);
    },
    async countOwners(orgId) {
      return [...membersById.values()].filter(
        (m) => m.orgId === orgId && m.role === 'owner' && m.status === 'active',
      ).length;
    },

    async insertTeam(team) {
      if (teams.size >= maxTeams) throw new OrgsError('ORGS_STORE_LIMIT', 'Team limit reached');
      if (teams.has(team.id)) throw new OrgsError('ORGS_TEAM_EXISTS', 'Team id already exists');
      if (teamsBySlug.has(teamSlugKey(team.orgId, team.slug))) {
        throw new OrgsError('ORGS_TEAM_EXISTS', 'Team slug already exists in organisation');
      }
      teams.set(team.id, clone(team));
      teamsBySlug.set(teamSlugKey(team.orgId, team.slug), team.id);
      return clone(team);
    },
    async updateTeam(team, expectedVersion) {
      const cur = teams.get(team.id);
      if (!cur) throw new OrgsError('ORGS_TEAM_NOT_FOUND', 'Team not found');
      if (cur.version !== expectedVersion) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Team version conflict');
      }
      if (cur.slug !== team.slug) {
        const key = teamSlugKey(team.orgId, team.slug);
        if (teamsBySlug.has(key)) throw new OrgsError('ORGS_TEAM_EXISTS', 'Team slug taken');
        teamsBySlug.delete(teamSlugKey(cur.orgId, cur.slug));
        teamsBySlug.set(key, team.id);
      }
      const next = { ...clone(team), version: cur.version + 1 };
      teams.set(team.id, next);
      return clone(next);
    },
    async getTeam(id) {
      const t = teams.get(id);
      return t ? clone(t) : null;
    },
    async getTeamBySlug(orgId, slug) {
      const id = teamsBySlug.get(teamSlugKey(orgId, slug));
      if (!id) return null;
      const t = teams.get(id);
      return t ? clone(t) : null;
    },
    async listTeams(orgId) {
      return [...teams.values()].filter((t) => t.orgId === orgId && !t.archivedAt).map(clone);
    },

    async insertTeamMembership(m) {
      const key = teamMemberKey(m.teamId, m.userId);
      if (teamMembersById.has(m.id) || teamMembersByKey.has(key)) {
        throw new OrgsError('ORGS_MEMBER_EXISTS', 'Team membership already exists');
      }
      teamMembersById.set(m.id, clone(m));
      teamMembersByKey.set(key, m.id);
      return clone(m);
    },
    async deleteTeamMembership(teamId, userId) {
      const key = teamMemberKey(teamId, userId);
      const id = teamMembersByKey.get(key);
      if (!id) return false;
      teamMembersByKey.delete(key);
      teamMembersById.delete(id);
      return true;
    },
    async getTeamMembership(teamId, userId) {
      const id = teamMembersByKey.get(teamMemberKey(teamId, userId));
      if (!id) return null;
      const m = teamMembersById.get(id);
      return m ? clone(m) : null;
    },
    async listTeamMemberships(teamId) {
      return [...teamMembersById.values()].filter((m) => m.teamId === teamId).map(clone);
    },
    async listTeamMembershipsForUser(orgId, userId) {
      return [...teamMembersById.values()]
        .filter((m) => m.orgId === orgId && m.userId === userId)
        .map(clone);
    },

    async insertInvitation(inv) {
      if (invitations.size >= maxInvitations) {
        throw new OrgsError('ORGS_STORE_LIMIT', 'Invitation limit reached');
      }
      if (invitations.has(inv.id)) {
        throw new OrgsError('ORGS_INVITATION_EXISTS', 'Invitation id already exists');
      }
      invitations.set(inv.id, clone(inv));
      return clone(inv);
    },
    async updateInvitation(inv, expectedVersion) {
      const cur = invitations.get(inv.id);
      if (!cur) throw new OrgsError('ORGS_INVITATION_NOT_FOUND', 'Invitation not found');
      if (cur.version !== expectedVersion) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Invitation version conflict');
      }
      const next = { ...clone(inv), version: cur.version + 1 };
      invitations.set(inv.id, next);
      return clone(next);
    },
    async getInvitation(id) {
      const inv = invitations.get(id);
      return inv ? clone(inv) : null;
    },
    async getPendingInvitationByEmail(orgId, email) {
      const inv = [...invitations.values()].find(
        (i) => i.orgId === orgId && i.email === email && i.status === 'pending',
      );
      return inv ? clone(inv) : null;
    },
    async listInvitations(query: StoreInvitationQuery) {
      return [...invitations.values()]
        .filter((i) => (query.orgId ? i.orgId === query.orgId : true))
        .filter((i) => (query.status ? i.status === query.status : true))
        .filter((i) => afterAsc(i, query.after))
        .sort(compareAsc)
        .slice(0, query.limit)
        .map(clone);
    },

    async upsertTenant(tenant) {
      tenants.set(tenant.orgId, clone(tenant));
      return clone(tenant);
    },
    async getTenant(orgId) {
      const t = tenants.get(orgId);
      return t ? clone(t) : null;
    },
    async deleteTenant(orgId) {
      return tenants.delete(orgId);
    },
  };
}
