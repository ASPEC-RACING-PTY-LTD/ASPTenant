import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import { OIDC_PATH } from '../oidc/provider.js';
import type { Platform } from '../platform.js';

/**
 * One HTTP listener for the API: the OpenID Connect provider (a Koa application) under /oidc,
 * everything else through Hono.
 */
export function createRequestListener(
  platform: Platform,
  app: Pick<Hono, 'fetch'>,
): (req: IncomingMessage, res: ServerResponse) => void {
  const hono = getRequestListener(app.fetch);
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === OIDC_PATH || path.startsWith(`${OIDC_PATH}/`)) {
      void platform.oidc.handle(req, res);
      return;
    }
    void hono(req, res);
  };
}
