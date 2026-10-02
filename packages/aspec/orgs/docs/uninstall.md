# Uninstall

1. Remove adapter mounts and tenant middleware.
2. Uninstall `@aspec/orgs`.
3. Drop SQL tables (`orgs_*`) if unused.
4. Drop any `tenant_*` schemas created by schema strategy.
