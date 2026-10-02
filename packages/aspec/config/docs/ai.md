# AI agent contract

## Purpose

Typed env/config loading with secret redaction and docs generation.

## Use when

You need validated configuration with secrets that must not leak into logs.

## Avoid when

You only need a single `process.env.FOO` read with no validation.

## Integration steps

1. Install `@aspec/config`.
2. Create a shape with `env.*` builders.
3. `export const config = defineConfig(shape)`.
4. Use `config.databaseUrl.reveal()` only when connecting to the database.
5. Optional: `aspec-config check ./src/config.ts` in CI.

## Verification

```bash
pnpm --filter @aspec/config test
node -e "import('@aspec/config').then(m => console.log(m.defineConfig({ p: m.env.port('PORT').default(1) }, { ignoreFiles: true, processEnv: {} }).p))"
```

## Common mistakes

- Logging `config` without `redactConfig`.
- Forgetting `.secret()` on credentials.
- Expecting live Vault without providing `fetch` credentials (mock-tested only).
