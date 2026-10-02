import type { EndpointResponse, ObservabilityEndpoints } from '../endpoints.js';
import {
  createHttpInstrumentation,
  type HttpInstrumentation,
  type HttpInstrumentationOptions,
} from '../http.js';

export function isHttpInstrumentation(value: unknown): value is HttpInstrumentation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HttpInstrumentation).start === 'function'
  );
}

export function resolveHttpInstrumentation(
  options: HttpInstrumentationOptions | HttpInstrumentation,
): HttpInstrumentation {
  return isHttpInstrumentation(options) ? options : createHttpInstrumentation(options);
}

/** Path without the query string. */
export function pathOf(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function headerReader(
  headers: Record<string, string | string[] | undefined> | Headers,
): (name: string) => string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    const h = headers as Headers;
    return (name) => h.get(name) ?? undefined;
  }
  const map = headers as Record<string, string | string[] | undefined>;
  return (name) => {
    const v = map[name.toLowerCase()] ?? map[name];
    if (Array.isArray(v)) return v[0];
    return v;
  };
}

export function applyEndpointResponse(
  res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  },
  response: EndpointResponse,
): void {
  res.statusCode = response.status;
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  res.end(response.body);
}

export function endpointRequestFrom(
  method: string,
  path: string,
  header: (name: string) => string | undefined,
): { method: string; path: string; header: (name: string) => string | undefined } {
  return { method, path, header };
}

export async function handleEndpoint(
  endpoints: ObservabilityEndpoints,
  method: string,
  path: string,
  header: (name: string) => string | undefined,
): Promise<EndpointResponse | undefined> {
  if (!endpoints.matches(path)) return undefined;
  return endpoints.handle({ method, path, header });
}
