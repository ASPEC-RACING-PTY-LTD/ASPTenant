# Troubleshooting

## `ORGS_CONFIG_INVALID`

Missing `mode`/`store` or invalid options.

## `ORGS_VALIDATION_FAILED`

Bad slug, email, role or settings field. See `details.issues`.

## `ORGS_NOT_FOUND` / `ORGS_SLUG_TAKEN` / `ORGS_ID_TAKEN`

Organisation lookup or uniqueness failure.

## `ORGS_VERSION_CONFLICT`

Optimistic concurrency mismatch; reload and retry.

## `ORGS_LAST_OWNER`

Cannot remove, demote or suspend the last active owner. Transfer ownership first.

## `ORGS_MEMBER_NOT_FOUND` / `ORGS_MEMBER_EXISTS` / `ORGS_NOT_ORG_MEMBER`

Membership state errors; team operations require active org membership.

## `ORGS_INVITATION_*` / `ORGS_TOKEN_*` / `ORGS_EMAIL_MISMATCH`

Invitation lifecycle: expired, revoked, throttled, duplicate, or email mismatch.

## `ORGS_TENANT_REQUIRED` / `ORGS_TENANT_FORBIDDEN` / `ORGS_TENANT_EXISTS`

No ALS context, user not a member, or tenant already provisioned.

## `ORGS_UNAUTHENTICATED` / `ORGS_FORBIDDEN`

HTTP actor missing or permission denied.
