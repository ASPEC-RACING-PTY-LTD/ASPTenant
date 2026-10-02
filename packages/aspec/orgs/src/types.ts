export const ORG_STATUSES = ['active', 'archived', 'deleted'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const MEMBER_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const BUILTIN_ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type BuiltinOrgRole = (typeof BUILTIN_ORG_ROLES)[number];

export const TEAM_ROLES = ['maintainer', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const TENANT_STRATEGIES = ['shared', 'schema', 'database'] as const;
export type TenantStrategy = (typeof TENANT_STRATEGIES)[number];

export interface Organisation {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  metadata: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
  version: number;
}

export interface Membership {
  id: string;
  orgId: string;
  userId: string;
  role: string;
  status: MemberStatus;
  invitedAt: number | null;
  joinedAt: number | null;
  suspendedAt: number | null;
  removedAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  version: number;
}

export interface TeamMembership {
  id: string;
  teamId: string;
  orgId: string;
  userId: string;
  role: TeamRole;
  createdAt: number;
  updatedAt: number;
}

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: string;
  teamIds: string[];
  status: InvitationStatus;
  invitedBy: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  lastSentAt: number | null;
  sendCount: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  version: number;
}

export interface InvitationRecord extends Invitation {
  tokenHash: string;
}

export interface TenantRecord {
  orgId: string;
  strategy: TenantStrategy;
  /** Schema name (strategy=schema) or opaque handle from the app provisioner. */
  handle: string | null;
  provisionedAt: number;
  deprovisionedAt: number | null;
  metadata: Record<string, unknown>;
}

export interface TenantContext {
  orgId: string;
  slug: string;
  strategy: TenantStrategy;
  handle: string | null;
  userId: string;
  roles: readonly string[];
  teamIds: readonly string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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
