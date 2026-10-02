# Examples

```ts
import { defineError } from '@aspec/errors';
const PaymentFailedError = defineError('PAYMENT_FAILED', { status: 402, expose: true, category: 'client' });
throw new PaymentFailedError('Card declined', { details: { reason: 'insufficient_funds' } });
```
