# Hono

```ts
import { createHonoErrorHandling } from '@aspec/errors/hono';
const errors = createHonoErrorHandling({ typeBaseUri: 'https://api.example.com/errors/' });
app.use('*', errors.middleware);
app.notFound(errors.notFound);
app.onError(errors.onError);
```

Tested on Hono 4.13.10.
