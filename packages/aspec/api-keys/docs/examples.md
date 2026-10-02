# Examples

## Rotate with grace

```ts
const { secret } = await apiKeys.rotate(id, { gracePeriodMs: 86_400_000 });
```

## Service account

```ts
const sa = await apiKeys.createServiceAccount({ name: 'billing-bot' });
const { secret } = await apiKeys.create({
  name: 'prod',
  scopes: ['billing:read'],
  ownerType: 'service_account',
  ownerId: sa.id,
});
await apiKeys.updateServiceAccount(sa.id, { enabled: false });
```
