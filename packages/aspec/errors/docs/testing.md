# Testing

```ts
const handler = createErrorHandler({ environment: 'test' });
expect(handler.render(new NotFoundError('x')).status).toBe(404);
```
