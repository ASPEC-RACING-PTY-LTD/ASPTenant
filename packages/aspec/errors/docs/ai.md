# AI integration

## Purpose
RFC 9457 problem+json errors with typed AppError classes.

## Use when
Shared API error contract across Express/Fastify/Hono/Fetch.

## Avoid when
One-off prototypes with no shared error shape.

## Prerequisites
Node >= 22.13. Framework peers as needed.

## Integration steps
1. Import createErrorHandler and typed errors from @aspec/errors.
2. Mount the matching adapter last.
3. Throw AppError subclasses from handlers.
4. Confirm problem+json without stacks in production.

## Configuration
typeBaseUri, debug, logger, correlation, redact.

## Verification
`pnpm --filter @aspec/errors test`

## Common mistakes
Error handler mounted before routes; missing asyncHandler on Express 4; expose:true with secret messages.

## Uninstall
Remove middleware and dependency.
