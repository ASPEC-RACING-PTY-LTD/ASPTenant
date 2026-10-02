# @aspec/errors

Consistent application errors for Node.js APIs: typed `AppError` classes, HTTP mapping, RFC 9457 problem details, redaction, correlation IDs, logging and recovery middleware for Express, Fastify, Hono and Fetch.

## Install

```bash
aspec add aspec/errors
# or
pnpm add @aspec/errors
```

## Quick start

```ts
import { createErrorHandler, NotFoundError } from '@aspec/errors';
import { createExpressErrorHandling } from '@aspec/errors/express';

const errors = createExpressErrorHandling({ typeBaseUri: 'https://api.example.com/errors/' });
app.use(errors.requestContext);
// routes...
app.use(errors.notFound);
app.use(errors.errorHandler);

throw new NotFoundError('Order not found');
```

## Docs

See `docs/` (summary, install, configure, integrate, frameworks, api, security, ai).

## Licence

MIT
