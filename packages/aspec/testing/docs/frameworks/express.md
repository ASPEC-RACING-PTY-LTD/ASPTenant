# Express

`createTestClient` detects Express 4 and 5 apps as Node request listeners, binds an ephemeral loopback server, and closes it via `client.close()` or `cleanupAll()`.

```ts
import express from 'express';
import { createTestClient, actAs, createTestJwtSigner } from '@aspec/testing';

const app = express();
app.get('/me', (req, res) => {
  res.json({ auth: req.header('authorization') ?? null });
});

const client = createTestClient(app);
await client.get('/me').expect(200).expectJson({ auth: null });

const signer = createTestJwtSigner({ secret: Buffer.alloc(32, 1) });
const authed = actAs(client, { subject: { id: 'u1' }, signer });
await authed.get('/me').expect((res) => {
  expect(res.json().auth).toMatch(/^Bearer /);
});
await client.close();
```

Tested with Express 5.2.1 and Express 4.22.3 (`express4` package alias in this repo's tests).
