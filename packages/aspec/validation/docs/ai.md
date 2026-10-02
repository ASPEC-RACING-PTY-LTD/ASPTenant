# AI integration

## Purpose
Standard Schema validation with structured issues and HTTP middleware.

## Use when
Validating request bodies/query/params or configuration with zod/valibot/JSON Schema.

## Avoid when
You need a full REST toolkit (use @aspec/api).

## Prerequisites
Node >= 22.13. A Standard Schema library (zod 4 or valibot 1 recommended).

## Integration steps
1. Define schemas with zod/valibot.
2. Use validate/parse in services or validateRequest middleware.
3. Let ValidationError map via @aspec/errors or built-in toProblemDetails.

## Configuration
status, bodyLimit, messages, sensitiveKeys for config validation.

## Verification
`pnpm --filter @aspec/validation test`

## Common mistakes
Forgetting JSON body parser before Express middleware; using validateSync with async refine rules.

## Uninstall
Remove middleware and dependency.
