# Hono

```ts
import { validateRequest } from '@aspec/validation/hono';
app.post('/users', validateRequest({ body: schema }), (c) => c.json(c.get('validated')));
```

Tested on Hono 4.13.10.
