# Configure

Construct the service with `createUsers(options)`. Invalid options throw
`USERS_CONFIG_INVALID` or `USERS_VALIDATION_FAILED`.

## Required

| Option | Description |
|--------|-------------|
| `store` | `UsersStore` from `@aspec/users/memory` or `@aspec/users/sql` |

## Optional ports

| Option | Port | Behaviour when omitted |
|--------|------|------------------------|
| `mailer` | `Mailer` | Invitation tokens are returned for manual delivery |
| `jobs` | `JobQueue` | No automatic `users.purge` scheduling; call `purgeExpired()` |
| `audit` | `AuditSink` | No audit events |
| `permissions` | `PermissionChecker` | Admin routes that need permissions return forbidden |
| `logger` | `LoggerLike` | No-op logger |
| `clock` | `Clock` | `Date.now` |
| `generateId` | `IdGenerator` | UUID v7 |

## Behaviour options

| Option | Default | Description |
|--------|---------|-------------|
| `defaultStatus` | `active` | Status for `createUser` when omitted |
| `profileFields` | `{}` | Custom profile field definitions |
| `settings` | `{}` | Account settings definitions |
| `preferences` | `{}` | Preference definitions with defaults |
| `profile.displayNameMaxLength` | `100` | Display name limit |
| `profile.bioMaxLength` | `2000` | Bio limit |
| `profile.allowHttpAvatars` | `false` | Allow `http:` avatar URLs |
| `activation.tokenTtlMs` | 72h | Activation token lifetime |
| `invitations.ttlMs` | 7d | Invitation lifetime |
| `invitations.resendIntervalMs` | 60s | Resend throttle |
| `invitations.maxSends` | `5` | Max sends per invitation |
| `invitations.acceptUrl` | unset | Accept link template |
| `invitations.appName` | `our application` | Email branding |
| `deletion.gracePeriodMs` | 30d | Soft-delete grace period |
| `deletion.policy` | `anonymise` | `anonymise` or `hard-delete` |
| `activity.retentionMs` | 365d | Prune retention |
| `hooks` | unset | Lifecycle hooks |

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `USERS_DATABASE_URL` | no | PostgreSQL URL when wiring SQL yourself |
| `USERS_ACCEPT_URL` | no | Invitation accept URL |
| `USERS_APP_NAME` | no | Name in invitation emails |

These env vars are read by generated setup templates; the core factory does not
read `process.env` itself except through values you pass in.
