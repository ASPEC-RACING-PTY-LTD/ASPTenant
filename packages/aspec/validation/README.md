# @aspec/validation

Standard Schema based validation for requests and configuration. Works with zod 4, valibot 1 and JSON Schema (Ajv). Structured issues (path, JSON Pointer, code), custom rules via `refine`, RFC 9457 problem details and middleware for Express, Fastify, Hono and Fetch.

## Install

```bash
aspec add aspec/validation
# or
pnpm add @aspec/validation
```

## Quick start

```ts
import { z } from 'zod';
import { validate, ValidationError } from '@aspec/validation';
import { validateRequest } from '@aspec/validation/express';

const schema = z.object({ email: z.email() });
app.post('/users', validateRequest({ body: schema }), (req, res) => {
  res.json(req.validated.body);
});
```

## Docs

See `docs/` (summary, install, configure, integrate, frameworks, api, security, ai).

## Licence

MIT
