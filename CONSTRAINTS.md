# Constraints

Last reviewed: 2026-10-02

Read this file before writing code. Do not weaken it to make a change pass.

## Floor (always enforced)

- No new suppression comments: `@ts-ignore`, `eslint-disable`, `# noqa`, `# type: ignore`
- No unimplemented stubs on critical paths. Planned work lives in documentation or explicit `implemented: false` capability maps.
- No skipped or deleted tests without a reason
- No secrets in source
- This file does not get weakened to make a change pass
- No em dashes in code, comments, UI copy or documentation

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Types | Zero type errors | `pnpm typecheck` | task end |
| Tests | API and web suites pass | `pnpm test` | task end |
| Lint | Zero Biome errors on first-party apps | `pnpm exec biome check apps docs` | task end |

Vendored packages under `packages/aspec` keep their original quality bar. Do not edit them to silence a new application error.

## Measured, not yet enforced

Coverage, accessibility budgets and Docker image scanning are recorded after the first CI run.
