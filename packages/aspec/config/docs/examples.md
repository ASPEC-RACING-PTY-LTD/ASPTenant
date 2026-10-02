# Examples

See integrate.md for the primary example. Generate docs:

```ts
import { generateEnvExample, generateMarkdownDocs } from '@aspec/config';
import { shape } from './config-shape.js';

process.stdout.write(generateEnvExample(shape));
process.stdout.write(generateMarkdownDocs(shape));
```

Zod JSON field:

```ts
import { z } from 'zod';
import { env } from '@aspec/config';

env.json('FEATURE_FLAGS', z.object({ beta: z.boolean() }));
```
