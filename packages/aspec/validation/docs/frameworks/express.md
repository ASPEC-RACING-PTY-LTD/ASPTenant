# Express

```ts
import { validateRequest } from '@aspec/validation/express';
app.post('/users', validateRequest({ body: schema }), (req, res) => res.json(req.validated.body));
```

Tested on Express 4.22.3 and 5.2.1.
