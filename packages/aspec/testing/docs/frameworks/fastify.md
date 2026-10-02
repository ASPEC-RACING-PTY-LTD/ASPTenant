# Fastify

Uses `app.inject` (no network). Call `await app.ready()` before creating the client.

```ts
import Fastify from 'fastify';
import { createTestClient } from '@aspec/testing';

const app = Fastify();
app.get('/ping', async () => ({ ok: true }));
await app.ready();

const client = createTestClient(app);
await client.get('/ping').expect(200).expectJson({ ok: true });
```

Tested with Fastify 5.12.5.
