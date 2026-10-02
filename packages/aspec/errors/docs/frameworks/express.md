# Express

```ts
import { asyncHandler, createExpressErrorHandling } from '@aspec/errors/express';
import { NotFoundError } from '@aspec/errors';
const errors = createExpressErrorHandling({ typeBaseUri: 'https://api.example.com/errors/' });
app.use(errors.requestContext);
app.get('/x', asyncHandler(async () => { throw new NotFoundError('missing'); }));
app.use(errors.notFound);
app.use(errors.errorHandler);
```

Tested on Express 4.22.3 and 5.2.1.
