# Uninstall

1. Remove middleware or plugin registration from your application.
2. Delete the generated setup file (`src/aspec/rate-limit.setup.ts` or `.js`).
3. Remove `@aspec/rate-limit` from package dependencies.
4. If you used Redis, optionally delete keys matching your prefix (`SCAN` + `DEL`). Keys also expire with window and ban TTLs.

No SQL tables are created. In-memory state is discarded when the process exits.
