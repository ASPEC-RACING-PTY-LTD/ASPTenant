import type { Api } from '../api.js';

/** Web Fetch handler backed by an Api. */
export function createFetchApi(api: Api): (request: Request) => Promise<Response> {
  return (request) => api.handle(request);
}
