# Configure

## Dotenv precedence

Later file entries override earlier ones; **real process environment always wins**:

1. `.env`
2. `.env.local` (skipped when `NODE_ENV=test`)
3. `.env.<NODE_ENV>`
4. `.env.<NODE_ENV>.local`
5. `process.env`

Expansion (`$VAR` / `${VAR}`) is off by default. Enable with `expand: true`.
`<NAME>_FILE` is read when `<NAME>` is unset (disable per field with `.noFile()`).

## defineConfig options

| Option | Default | Description |
|--------|---------|-------------|
| `cwd` | `process.cwd()` | Directory for dotenv files |
| `nodeEnv` | `NODE_ENV` or `development` | Selects env-specific files |
| `processEnv` | `process.env` | Environment overlay |
| `expand` | `false` | Expand dotenv values |
| `ignoreFiles` | `false` | Skip dotenv files |
| `freeze` | `true` | Deep-freeze the result |

## Secrets

`.secret()` wraps values in `Secret<T>`: `toString`, `toJSON` and `inspect` redact;
call `.reveal()` only at trusted boundaries. `redactConfig(config)` deep-redacts for logging.
