# Summary

`@aspec/config` loads and validates application configuration from environment
variables and dotenv files. Use it for typed defaults, required secrets,
environment-specific files, aggregated validation errors and documentation
generation. Secrets are wrapped so they cannot leak through logs or docs.
Optional providers (Vault KV v2, AWS Secrets Manager, file directories) feed
`loadConfig` asynchronously while `defineConfig` stays synchronous.
