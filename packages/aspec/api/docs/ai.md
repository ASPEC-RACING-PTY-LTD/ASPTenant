# AI integration

## Purpose
Typed REST routes with OpenAPI, validation and safe errors.

## Use when
Building multi-route HTTP APIs that need OpenAPI and consistent responses.

## Avoid when
Single webhook handler (use validation/errors alone).

## Prerequisites
@aspec/errors, @aspec/validation, Node >= 22.13.

## Integration steps
1. defineRoute for each operation with Standard Schema request parts.
2. createApi({ info, routes, versioning? }).
3. Mount createFetchApi / createExpressApi / etc.
4. Publish /openapi.json and /docs.

## Configuration
info, versioning, pagination limits, cursorSecret, field whitelists.

## Verification
`pnpm --filter @aspec/api test`

## Common mistakes
Non-whitelisted filter fields; unsigned cursors in production; mounting without JSON body parser on Express when bypassing createApi body parsing.

## Uninstall
Remove mount and dependency.
