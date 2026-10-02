# Examples

## Invite and accept without a mailer

```ts
const invite = await users.inviteUser({ email: 'bob@example.com', roles: ['editor'] });
// deliver invite.token yourself
const { user, created } = await users.acceptInvitation(invite.token!);
```

## Typed preferences

```ts
const users = createUsers({
  store,
  preferences: {
    theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
    digest: { type: 'boolean', default: true },
  },
});
await users.updatePreferences(user.id, { theme: 'dark' });
const prefs = await users.getPreferences(user.id); // { theme: 'dark', digest: true }
```

## Soft delete and purge hook

```ts
users.on('user.purging', async ({ user }) => {
  await appDb.deleteAllForUser(user.id);
});
await users.requestDeletion(user.id);
// after grace period:
await users.purgeExpired();
```

## Suspension with clock

```ts
const until = clock.now() + 3_600_000;
await users.suspendUser(id, { reason: 'Cool-off', until });
// later, when until has passed:
await users.canSignIn(id); // reinstates and returns true
```
