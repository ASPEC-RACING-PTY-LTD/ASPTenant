import type { FastifyPluginAsync } from 'fastify';
import type { Api } from '../api.js';

export interface FastifyApiOptions {
  prefix?: string;
}

/** Fastify plugin that mounts an Api as a catch-all handler under an optional prefix. */
export const fastifyApi: FastifyPluginAsync<{ api: Api } & FastifyApiOptions> = async (
  app,
  opts,
) => {
  app.all('/*', async (request, reply) => {
    const url = `${request.protocol}://${request.hostname}${request.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const init: RequestInit = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== undefined) {
      init.body = JSON.stringify(request.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    const req = new Request(url, init);
    const path = request.url.split('?')[0] ?? '/';
    const prefix = opts.prefix ?? '';
    const stripped =
      prefix && (path === prefix || path.startsWith(`${prefix}/`))
        ? path === prefix
          ? '/'
          : path.slice(prefix.length)
        : path;
    const response = await opts.api.handle(req, {
      path: stripped,
      params: request.params as Record<string, string>,
      query: request.query as Record<string, string>,
      body: request.body,
    });
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      void reply.header(key, value);
    });
    const buf = Buffer.from(await response.arrayBuffer());
    return reply.send(buf.length === 0 ? null : buf);
  });
};
