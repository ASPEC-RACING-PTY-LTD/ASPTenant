# Testing

Use `ignoreFiles: true` and a controlled `processEnv`. Assert that
`ConfigError.toReport()` never contains secret literals. For Vault, mock `fetch`.
