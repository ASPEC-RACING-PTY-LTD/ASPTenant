import type {
  InvitationRecord,
  Membership,
  Organisation,
  Team,
  TeamMembership,
  TenantRecord,
} from './types.js';

export interface AscPosition {
  createdAt: number;
  id: string;
}

export interface StoreOrgQuery {
  status?: string;
  search?: string;
  limit: number;
  after?: AscPosition;
}

export interface StoreMemberQuery {
  orgId: string;
  status?: string;
  limit: number;
  after?: AscPosition;
}

export interface StoreInvitationQuery {
  orgId?: string;
  status?: string;
  limit: number;
  after?: AscPosition;
}

export interface OrgsStore {
  insertOrg(org: Organisation): Promise<Organisation>;
  updateOrg(org: Organisation, expectedVersion: number): Promise<Organisation>;
  getOrg(id: string): Promise<Organisation | null>;
  getOrgBySlug(slug: string): Promise<Organisation | null>;
  listOrgs(query: StoreOrgQuery): Promise<Organisation[]>;

  insertMembership(m: Membership): Promise<Membership>;
  updateMembership(m: Membership, expectedVersion: number): Promise<Membership>;
  getMembership(orgId: string, userId: string): Promise<Membership | null>;
  getMembershipById(id: string): Promise<Membership | null>;
  listMemberships(query: StoreMemberQuery): Promise<Membership[]>;
  listMembershipsForUser(userId: string): Promise<Membership[]>;
  countOwners(orgId: string): Promise<number>;

  insertTeam(team: Team): Promise<Team>;
  updateTeam(team: Team, expectedVersion: number): Promise<Team>;
  getTeam(id: string): Promise<Team | null>;
  getTeamBySlug(orgId: string, slug: string): Promise<Team | null>;
  listTeams(orgId: string): Promise<Team[]>;

  insertTeamMembership(m: TeamMembership): Promise<TeamMembership>;
  deleteTeamMembership(teamId: string, userId: string): Promise<boolean>;
  getTeamMembership(teamId: string, userId: string): Promise<TeamMembership | null>;
  listTeamMemberships(teamId: string): Promise<TeamMembership[]>;
  listTeamMembershipsForUser(orgId: string, userId: string): Promise<TeamMembership[]>;

  insertInvitation(inv: InvitationRecord): Promise<InvitationRecord>;
  updateInvitation(inv: InvitationRecord, expectedVersion: number): Promise<InvitationRecord>;
  getInvitation(id: string): Promise<InvitationRecord | null>;
  getPendingInvitationByEmail(orgId: string, email: string): Promise<InvitationRecord | null>;
  listInvitations(query: StoreInvitationQuery): Promise<InvitationRecord[]>;

  upsertTenant(tenant: TenantRecord): Promise<TenantRecord>;
  getTenant(orgId: string): Promise<TenantRecord | null>;
  deleteTenant(orgId: string): Promise<boolean>;
}
