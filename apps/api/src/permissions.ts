import { defineRbac } from '@aspec/rbac';

/**
 * Permissions evaluated inside one tenant (organisation). Roles that grant them are assigned
 * in organisation scope, so holding them in one tenant grants nothing in another.
 */
export const TENANT_PERMISSIONS = [
  { key: 'users:read', description: 'Read user identities and profiles.' },
  { key: 'users:update', description: 'Update user profiles and account state.' },
  { key: 'users:suspend', description: 'Suspend or reinstate users.' },
  { key: 'users:delete', description: 'Request or complete user deletion.' },
  { key: 'users:invite', description: 'Invite users into the organisation.' },
  { key: 'orgs:read', description: 'Read organisation and membership data.' },
  { key: 'orgs:update', description: 'Update the organisation.' },
  { key: 'orgs.members:read', description: 'List organisation members.' },
  { key: 'orgs.members:manage', description: 'Change organisation memberships and roles.' },
  { key: 'orgs:invite', description: 'Invite organisation members.' },
  { key: 'orgs:settings', description: 'Change organisation settings.' },
  { key: 'groups:read', description: 'Read security and distribution groups.' },
  { key: 'groups:manage', description: 'Create and change groups and membership.' },
  { key: 'audit:read', description: 'Read administrative and security audit events.' },
  { key: 'system:read', description: 'Read system health and diagnostics.' },
  { key: 'mail:read', description: 'Read mailbox and mail-transport configuration.' },
  { key: 'mail:manage', description: 'Manage mailboxes, aliases and mail transport.' },
  { key: 'apps:read', description: 'Read registered applications.' },
  { key: 'apps:manage', description: 'Manage application registrations.' },
  { key: 'domains:read', description: 'Read custom domains.' },
  { key: 'domains:manage', description: 'Register, verify and remove custom domains.' },
  { key: 'security:read', description: 'Read security policy and user sessions.' },
  { key: 'security:manage', description: 'Change security policy and revoke user sessions.' },
  { key: 'migration:read', description: 'Read mailbox import jobs.' },
  { key: 'migration:manage', description: 'Run mailbox imports.' },
] as const;

/** Permissions evaluated in global scope. They never grant access to a tenant's data. */
export const PLATFORM_PERMISSIONS = [
  { key: 'platform:admin', description: 'Operate the ASPECTenant installation.' },
  { key: 'tenants:read', description: 'List tenants and their memberships.' },
  { key: 'tenants:manage', description: 'Create, archive and restore tenants and add members.' },
  {
    key: 'domains:override',
    description: 'Confirm domain ownership without a DNS check (operator override).',
  },
] as const;

export type TenantPermission = (typeof TENANT_PERMISSIONS)[number]['key'];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number]['key'];

export const PLATFORM_OPERATOR_ROLE = 'platform.operator';
export const TENANT_OWNER_ROLE = 'tenant.owner';
export const TENANT_ADMIN_ROLE = 'tenant.admin';
export const TENANT_AUDITOR_ROLE = 'tenant.auditor';

/** Tenant roles an administrator may assign to other members. Ownership is not assignable. */
export const ASSIGNABLE_TENANT_ROLES = [TENANT_ADMIN_ROLE, TENANT_AUDITOR_ROLE] as const;
export type AssignableTenantRole = (typeof ASSIGNABLE_TENANT_ROLES)[number];

export const TENANT_ROLES = [TENANT_OWNER_ROLE, TENANT_ADMIN_ROLE, TENANT_AUDITOR_ROLE] as const;

const TENANT_ADMIN_PERMISSIONS: TenantPermission[] = [
  'users:read',
  'users:update',
  'users:suspend',
  'users:invite',
  'orgs:read',
  'orgs:update',
  'orgs.members:read',
  'orgs.members:manage',
  'orgs:invite',
  'orgs:settings',
  'groups:read',
  'groups:manage',
  'audit:read',
  'system:read',
  'mail:read',
  'mail:manage',
  'apps:read',
  'apps:manage',
  'domains:read',
  'domains:manage',
  'security:read',
  'security:manage',
  'migration:read',
  'migration:manage',
];

const TENANT_AUDITOR_PERMISSIONS: TenantPermission[] = [
  'users:read',
  'orgs:read',
  'orgs.members:read',
  'groups:read',
  'audit:read',
  'system:read',
  'mail:read',
  'apps:read',
  'domains:read',
  'security:read',
  'migration:read',
];

export const platformRbacDefinition = defineRbac({
  permissions: [...TENANT_PERMISSIONS, ...PLATFORM_PERMISSIONS],
  roles: [
    {
      key: PLATFORM_OPERATOR_ROLE,
      name: 'Platform operator',
      description:
        'Runs the installation: creates and archives tenants. Holds no access to tenant data unless also a member of that tenant.',
      permissions: PLATFORM_PERMISSIONS.map((permission) => permission.key),
      assignableScopes: ['global'],
    },
    {
      key: TENANT_OWNER_ROLE,
      name: 'Organisation owner',
      description: 'Owner of one tenant. Holds every tenant permission inside that tenant.',
      permissions: TENANT_PERMISSIONS.map((permission) => permission.key),
      assignableScopes: ['org'],
    },
    {
      key: TENANT_ADMIN_ROLE,
      name: 'Administrator',
      description: 'Day-to-day administration of one tenant.',
      permissions: TENANT_ADMIN_PERMISSIONS,
      assignableScopes: ['org'],
    },
    {
      key: TENANT_AUDITOR_ROLE,
      name: 'Auditor',
      description: 'Read-only access to one tenant and its audit history.',
      permissions: TENANT_AUDITOR_PERMISSIONS,
      assignableScopes: ['org'],
    },
  ],
});
