# Uninstall

1. Remove middleware, hooks and admin router/plugin registrations.
2. Remove generated setup files under `src/aspec/`.
3. Uninstall the package: `pnpm remove @aspec/rbac`.
4. If you used the SQL store, drop the `rbac_*` tables (or your configured prefix) manually. Tables are not dropped automatically.
5. Remove any React `PermissionProvider` wrappers and server snapshot endpoints.
