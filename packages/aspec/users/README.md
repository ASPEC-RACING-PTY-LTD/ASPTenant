# @aspec/users

Reusable user account management for Node.js applications: profiles, settings,
preferences, suspension, activation, invitations, soft deletion with purge, and
activity history.

Integrates with authentication and authorisation through structural ports
(`PermissionChecker`, `Mailer`, `JobQueue`, `AuditSink`). No dependency on
`@aspec/auth` or `@aspec/rbac`.

## Install

```bash
aspec add aspec/users
# or
pnpm add @aspec/users
```

See [docs/install.md](docs/install.md).

## Quick start

```ts
import { createUsers } from '@aspec/users';
import { createMemoryUsersStore } from '@aspec/users/memory';

const users = createUsers({ store: createMemoryUsersStore() });
const user = await users.createUser({ email: 'ada@example.com', profile: { displayName: 'Ada' } });
```

## Documentation

- [Summary](docs/summary.md)
- [Configure](docs/configure.md)
- [Integrate](docs/integrate.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [AI agent guide](docs/ai.md)

## Licence

MIT
