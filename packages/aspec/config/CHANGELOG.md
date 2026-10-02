# Changelog

## [1.0.0] - 2026-09-29

### Added

- Typed `defineConfig` / `env.*` builders with full inference.
- Dotenv loading with documented precedence and optional safe expansion.
- `<NAME>_FILE` secret file support and aggregated `CONFIG_INVALID` errors.
- `Secret<T>` redaction for string, JSON and `util.inspect`.
- Docs generators: `.env.example`, Markdown, JSON Schema.
- CLI `aspec-config` (`check`, `docs`, `example`).
- Secret providers: Vault KV v2 (fetch), AWS Secrets Manager (structural client), file directory.
- Async `loadConfig` for provider-backed secrets.
