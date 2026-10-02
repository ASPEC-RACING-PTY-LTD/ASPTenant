# Integrate

```ts
import { z } from 'zod';
import { parse, refine, rules } from '@aspec/validation';
const schema = refine(z.object({ password: z.string(), confirm: z.string() }), [rules.fieldsMatch('password', 'confirm')]);
await parse(schema, { password: 'x', confirm: 'x' });
```
