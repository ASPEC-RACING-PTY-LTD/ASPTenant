# Testing

```ts
import { createContractTester } from '@aspec/api/testing';
const tester = createContractTester(api.openapi());
tester.expectResponse('get', '/health', { status: 200, body: { ok: true } });
```
