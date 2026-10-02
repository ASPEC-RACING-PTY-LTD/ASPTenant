# Fastify

```ts
import { validateRequest } from '@aspec/validation/fastify';
app.post('/users', { preHandler: validateRequest({ body: schema }) }, async (req) => req.validated);
```

Tested on Fastify 5.12.5.
