# @aspec/api

REST API development utilities: typed routes, OpenAPI 3.1 generation, request validation (@aspec/validation), problem errors (@aspec/errors), pagination, filtering/sorting, versioning, HTML docs, contract testing and client generation. Adapters for Express, Fastify, Hono and Fetch.

## Install

```bash
aspec add aspec/api
# or
pnpm add @aspec/api
```

Requires `@aspec/errors` and `@aspec/validation`.

## Quick start

```ts
import { z } from 'zod';
import { createApi, defineRoute, ok } from '@aspec/api';
import { createFetchApi } from '@aspec/api/fetch';

const api = createApi({
  info: { title: 'Demo', version: '1.0.0' },
  routes: [
    defineRoute({
      method: 'get',
      path: '/hello',
      request: { query: z.object({ name: z.string() }) },
      handler: async ({ request }) => ok({ hello: request.query.name }),
    }),
  ],
});

export default createFetchApi(api);
```

## Docs

See `docs/` (summary, install, configure, integrate, frameworks, api, security, ai).

## Licence

MIT
