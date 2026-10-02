# Integrate

```ts
import { createApi, defineRoute, ok } from '@aspec/api';
import { createFetchApi } from '@aspec/api/fetch';
import { z } from 'zod';
const api = createApi({
  info: { title: 'Demo', version: '1.0.0' },
  routes: [defineRoute({ method: 'get', path: '/health', handler: async () => ok({ ok: true }) })],
});
export default createFetchApi(api);
```

OpenAPI at GET /openapi.json, HTML docs at GET /docs.
