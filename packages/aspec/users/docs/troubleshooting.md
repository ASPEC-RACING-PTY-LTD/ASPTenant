# Troubleshooting

Organised by error code.

## `USERS_CONFIG_INVALID`

Factory options are missing or malformed (for example no `store`). Fix the
`createUsers` call.

## `USERS_VALIDATION_FAILED`

Input failed field or format validation. Inspect `error.details.issues` for
`path` and `message`.

## `USERS_NOT_FOUND`

No user with that id. Confirm the id and that the account was not hard-deleted.

## `USERS_EMAIL_TAKEN` / `USERS_ID_TAKEN` / `USERS_EXTERNAL_ID_TAKEN`

Uniqueness conflict. Use a different email, id, or external identity.

## `USERS_VERSION_CONFLICT`

Optimistic concurrency failure. Reload the user and retry with the current
`version` (or `If-Match`).

## `USERS_INVALID_STATE`

Operation not allowed for the current status (for example activating a deleted
account).

## `USERS_SUSPENDED`

Account is suspended. Admins can `reactivateUser`; expired `until` is cleared by
`canSignIn` or maintenance.

## `USERS_TOKEN_INVALID` / `USERS_TOKEN_EXPIRED`

Activation or invitation token missing, forged, already used, or past expiry.

## `USERS_INVITATION_NOT_FOUND` / `USERS_INVITATION_EXISTS`

Invitation id unknown, or a pending invite already exists for that email.

## `USERS_INVITATION_EXPIRED` / `USERS_INVITATION_REVOKED`

Invite can no longer be accepted. Create a new invitation.

## `USERS_INVITATION_THROTTLED`

Resend called too soon. Wait for `resendIntervalMs`.

## `USERS_ALREADY_ACTIVE`

Activation attempted on an already active account.

## `USERS_INVALID_CURSOR`

Malformed list cursor. Omit the cursor or start a new page.

## `USERS_UNAUTHENTICATED` / `USERS_FORBIDDEN`

HTTP actor missing, or PermissionChecker denied the required `users:*`
permission.

## `USERS_PAYLOAD_TOO_LARGE`

Request body exceeded `bodyLimit` (default 64 KiB).

## `USERS_STORE_LIMIT`

In-memory store capacity reached. Raise limits or use SQL.

## `USERS_HOOK_FAILED`

A lifecycle hook threw. Fix the hook; purge will retry on the next run.
