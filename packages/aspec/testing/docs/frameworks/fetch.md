# Fetch handler

Pass any `(request: Request) => Response | Promise<Response>`. Suitable for Web-standard handlers; can be used from runtimes that expose the Fetch API without claiming those runtimes were tested here.

```ts
import { createTestClient } from '@aspec/testing';

const handler = (req: Request) => {
  const url = new URL(req.url);
  return Response.json({ path: url.pathname });
};

const client = createTestClient(handler);
await client.get('/x').expect(200).expectJson({ path: '/x' });
```

Tested on Node.js 24.16.0.
