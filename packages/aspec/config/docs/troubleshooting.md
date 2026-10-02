# Troubleshooting

## `CONFIG_INVALID`

One or more variables failed validation. Read `error.toReport()` or `error.toJSON().issues`.
Messages never include secret values.

## `CONFIG_PROVIDER_ERROR`

Vault, AWS or file provider failed. Check credentials, paths and network.

## `CONFIG_LOAD_ERROR`

CLI could not import the config module, or the module does not export `shape`.

## Secret printed in logs

Use `Secret` fields and `redactConfig` before logging. Never call `.reveal()` in log lines.
