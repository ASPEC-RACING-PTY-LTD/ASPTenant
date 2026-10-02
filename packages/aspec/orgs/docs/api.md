# API

## `createOrgs(options): OrgsService`

Requires `mode` and `store`. See [configure.md](configure.md).

## Organisations

`createOrg`, `getOrg`, `findOrg`, `getOrgBySlug`, `listOrgs`, `updateOrg`,
`archiveOrg`, `deleteOrg` (archive first), `getDefaultOrg` (single mode).

## Settings

`getSettings`, `updateSettings` with typed field definitions.

## Memberships

`addMember`, `changeMemberRole`, `suspendMember`, `reactivateMember`,
`removeMember`, `leaveOrg`, `transferOwnership`, `getMembership`, `listMembers`,
`listMembershipsForUser`. Last active owner is protected (`ORGS_LAST_OWNER`).

## Teams

`createTeam`, `updateTeam`, `archiveTeam`, `getTeam`, `listTeams`,
`addTeamMember`, `removeTeamMember`, `listTeamMembers`. Team members must be
active org members.

## Invitations

`invite`, `resendInvitation`, `revokeInvitation`, `acceptInvitation` (idempotent),
`getInvitation`, `listInvitations`. Mailer category `orgs.invitation`.

## Permissions

`can(userId, orgId, permission)`, `toSubject`, `permissionsForRole`. Uses the
role map and optionally delegates to `PermissionChecker`.

## Tenancy

`provisionTenant`, `deprovisionTenant`, `getTenant`, `enterTenant`,
`runWithTenant`, `currentTenant`, `requireTenant`, `tenantScope`,
`generateRlsPolicySql`.

## Stores

`createMemoryOrgsStore`, `createSqlOrgsStore`, `migrate`, `migrations`.

## HTTP

Express/Fastify/Hono/Fetch admin and member adapters; Express
`createTenantMiddleware`.
