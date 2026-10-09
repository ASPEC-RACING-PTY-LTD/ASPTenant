export const GROUP_KINDS = ['security', 'distribution'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const DOMAIN_STATUSES = ['pending', 'verified'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const MAILBOX_KINDS = ['user', 'shared'] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

export interface DirectoryGroup {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  kind: GroupKind;
  description: string | null;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface DirectoryGroupMember {
  groupId: string;
  userId: string;
  addedAt: number;
}

export interface DirectoryDomain {
  id: string;
  tenantId: string;
  hostname: string;
  status: DomainStatus;
  primary: boolean;
  createdAt: number;
  updatedAt: number;
  verifiedAt: number | null;
  /** Value the tenant publishes in DNS to prove ownership. */
  verificationToken: string;
}

export interface DirectoryMailbox {
  id: string;
  tenantId: string;
  userId: string | null;
  primaryAddress: string;
  kind: MailboxKind;
  displayName: string | null;
  quotaBytes: number | null;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DirectoryApplication {
  id: string;
  tenantId: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DirectoryCounts {
  groups: number;
  domains: number;
  mailboxes: number;
  applications: number;
}
