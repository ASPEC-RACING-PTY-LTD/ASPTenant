# Fetch

```ts
import { withErrorHandling } from '@aspec/errors/fetch';
export default withErrorHandling(async () => { throw new Error('x'); }, { typeBaseUri: 'https://api.example.com/errors/' });
```
