# Integrate

```ts
import { ConflictError, createErrorHandler } from '@aspec/errors';
const handler = createErrorHandler({ typeBaseUri: 'https://api.example.com/errors/' });
const response = handler.toResponse(new ConflictError('Name taken'));
```

Mount a framework adapter so uncaught errors become problem+json. Optionally call `installProcessHandlers({ logger })`.
