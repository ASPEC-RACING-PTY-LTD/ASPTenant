# Fastify

```ts
import { registerErrorHandling } from '@aspec/errors/fastify';
await registerErrorHandling(app, { typeBaseUri: 'https://api.example.com/errors/' });
```

Tested on Fastify 5.12.5.
