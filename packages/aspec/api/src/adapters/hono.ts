import { Hono } from 'hono';
import type { Api } from '../api.js';

/** Returns a Hono app that dispatches every request to the Api. */
export function createHonoApi(api: Api): Hono {
  const app = new Hono();
  app.all('*', async (c) => {
    const response = await api.handle(c.req.raw, {
      path: c.req.path,
      params: c.req.param(),
      query: c.req.query(),
    });
    return response;
  });
  return app;
}

/** Hono middleware that forwards to an Api (useful when nesting). */
export function honoApi(api: Api) {
  return async (
    c: {
      req: {
        raw: Request;
        path: string;
        param: () => Record<string, string>;
        query: () => Record<string, string>;
      };
    },
    next: () => Promise<void>,
  ) => {
    const response = await api.handle(c.req.raw, {
      path: c.req.path,
      params: c.req.param(),
      query: c.req.query(),
    });
    if (response.status === 404) {
      await next();
      return;
    }
    return response;
  };
}
