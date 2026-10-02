# API

## `defineConfig(shape, options?)`

Synchronously loads env + dotenv, validates, returns frozen `InferConfig<typeof shape>`.

## `env` builders

`string`, `number`, `integer`, `port`, `boolean`, `url`, `email`, `enum`, `list`,
`json` (optional Standard Schema via `~standard`), `duration`, `bytes`, `custom`.

Modifiers: `.default(v)`, `.optional()`, `.secret()`, `.description()`, `.example()`, `.noFile()`.

## `loadConfig({ shape, secrets, ... })`

Async; fetches provider secrets then calls `defineConfig`.

## Docs

`generateEnvExample`, `generateMarkdownDocs`, `toJSONSchema`.

## `Secret<T>` / `redactConfig`

Redacted wrappers and deep redaction helper.

## Providers

- `@aspec/config/vault` → `createVaultKvV2Provider`
- `@aspec/config/aws` → `createAwsSecretsManagerProvider`
- `@aspec/config/file` → `createFileSecretsProvider`

## CLI

`aspec-config check|docs|example <module>` (executes the module; must export `shape`).

## Errors

`ConfigError` with `code: CONFIG_INVALID | CONFIG_PROVIDER_ERROR | CONFIG_LOAD_ERROR`,
`toReport()` and `toJSON()` that never include secret values.
