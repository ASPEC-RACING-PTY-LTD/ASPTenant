# Uninstall

1. Remove auth router / plugin / fetch handler registrations from the application.
2. Remove environment variables listed in configure.md.
3. Uninstall the package (`pnpm remove @aspec/auth`) or delete the vendored copy.
4. Drop SQL tables if you no longer need accounts/sessions: use `tableNames()` from `@aspec/auth/sql` for the configured prefix. Tables are not dropped automatically.
5. Revoke OAuth client credentials at each identity provider.
