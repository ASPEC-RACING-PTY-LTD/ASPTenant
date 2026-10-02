# Hono

Uses `app.request` (no network).

```ts
import { Hono } from 'hono';
import { createTestClient } from '@aspec/testing';

const app = new Hono();
app.get('/ping', (c) => c.json({ ok: true }));

const client = createTestClient(app);
await client.get('/ping').expect(200).expectJson({ ok: true });
```

Pass `options.hono.env` / `executionCtx` when the app needs bindings.

Tested with Hono 4.13.10.
