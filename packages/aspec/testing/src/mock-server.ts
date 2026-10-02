import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerCleanup } from './cleanup.js';
import { invalidOption, TestingAssertionError } from './errors.js';
import {
  describeRequest,
  type MockRequest,
  type MockRoute,
  parseBody,
  type RecordedCall,
  type ReplyInput,
  type RouteMatcher,
  RouteRegistry,
  type RouteShortcuts,
  routeShortcuts,
} from './routes.js';

export interface MockServerOptions {
  /** Respond 501 to unmatched requests and record them (default true). When false, respond 404. */
  strict?: boolean;
  /** Host to bind (default 127.0.0.1). */
  host?: string;
  /** Port (default 0: ephemeral). */
  port?: number;
  /** Request body limit in bytes (default 1 MiB); larger bodies get 413. */
  maxBodyBytes?: number;
  maxRecordedCalls?: number;
}

export interface MockServer extends RouteShortcuts {
  /** Base URL, for example http://127.0.0.1:53211 */
  readonly url: string;
  readonly port: number;
  readonly calls: readonly RecordedCall[];
  readonly unmatched: readonly MockRequest[];
  on(matcher: RouteMatcher, reply: ReplyInput): MockRoute;
  reset(): void;
  assertAllCalled(): void;
  assertNoUnmatched(): void;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i] as string, raw[i + 1] as string);
    } catch {
      // Header names Node accepted but the Fetch Headers class rejects are skipped.
    }
  }
  return headers;
}

/**
 * Starts a real HTTP server on an ephemeral loopback port with the same route API as
 * mockFetch, for clients that do not use fetch (axios, got, node:http, SDKs).
 */
export async function createMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const strict = options.strict ?? true;
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isInteger(limit) || limit < 0)
    throw invalidOption('maxBodyBytes', 'must be a non-negative integer');
  const max = options.maxRecordedCalls ?? 10_000;
  const registry = new RouteRegistry();
  const calls: RecordedCall[] = [];
  const unmatched: MockRequest[] = [];
  let origin = '';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const bytes = await readBody(req, limit);
    if (bytes === undefined) {
      res
        .writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        .end('mock server: request body too large');
      return;
    }
    const text = bytes.toString('utf8');
    const base = {
      method: (req.method ?? 'GET').toUpperCase(),
      url: new URL(req.url ?? '/', origin),
      headers: toHeaders(req),
      text,
      body: parseBody(text),
    };
    const match = registry.match(base);
    if (!match) {
      const request: MockRequest = { ...base, params: {} };
      calls.push({ request, route: undefined });
      unmatched.push(request);
      res
        .writeHead(strict ? 501 : 404, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`mock server: no route matched ${describeRequest(request)}`);
      return;
    }
    const request: MockRequest = { ...base, params: match.params };
    calls.push({ request, route: match.route });
    if (calls.length > max) calls.splice(0, calls.length - max);
    const spec = await match.route.respond(request);
    if (spec.delayMs > 0) await new Promise((r) => setTimeout(r, spec.delayMs));
    if (spec.kind === 'network-error') {
      req.socket.destroy();
      return;
    }
    res.writeHead(spec.status, spec.headers.flat());
    if (
      spec.body === null ||
      request.method === 'HEAD' ||
      spec.status === 204 ||
      spec.status === 304
    )
      res.end();
    else res.end(spec.body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`mock server handler failed: ${err instanceof Error ? err.message : String(err)}`);
      } else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  origin = `http://${host}:${address.port}`;

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closed) {
      unregister();
      closed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    }
    return closed;
  };
  const unregister = registerCleanup(close);

  const on = (matcher: RouteMatcher, input: ReplyInput): MockRoute => registry.add(matcher, input);
  return {
    ...routeShortcuts(on),
    url: origin,
    port: address.port,
    calls,
    unmatched,
    on,
    reset() {
      registry.clear();
      calls.length = 0;
      unmatched.length = 0;
    },
    assertAllCalled() {
      const pending = registry.pending();
      if (pending.length > 0) {
        throw new TestingAssertionError(
          `mock server: ${pending.length} route(s) not fully used:\n${pending.map((r) => `  ${r.describe()}`).join('\n')}`,
        );
      }
    },
    assertNoUnmatched() {
      if (unmatched.length > 0) {
        throw new TestingAssertionError(
          `mock server: ${unmatched.length} unmatched request(s):\n${unmatched.map((r) => `  ${describeRequest(r)}`).join('\n')}`,
        );
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
