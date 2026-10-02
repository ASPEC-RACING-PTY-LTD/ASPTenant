# Uninstall

1. Remove `@aspec/testing` from `devDependencies`.
2. Remove `aspec-testing` bin usages from scripts.
3. Delete generated setup files (`src/aspec/testing.setup.ts`, scaffolded `test/example.*.test.*`, `vitest.config.*` if created only for this module).
4. Remove `defineAspecVitestConfig` from your Vitest config if you no longer want the preset.
5. No application database tables need dropping; test schemas are ephemeral.
