# Examples

```ts
import { fromJsonSchema } from '@aspec/validation/ajv';
const schema = fromJsonSchema({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } });
```
