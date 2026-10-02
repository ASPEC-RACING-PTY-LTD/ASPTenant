# Fetch

```ts
import { withValidation } from '@aspec/validation/fetch';
export default withValidation({ body: schema }, async ({ validated }) => Response.json(validated));
```
