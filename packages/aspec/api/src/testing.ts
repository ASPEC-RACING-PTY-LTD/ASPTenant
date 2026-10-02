import { Ajv2020 } from 'ajv/dist/2020.js';
import type { OpenApiDocument } from './openapi.js';

export interface ContractTesterOptions {
  /** Existing Ajv instance. */
  instance?: Ajv2020;
}

export interface ContractAssertion {
  status: number;
  /** Parsed JSON body (or null for empty). */
  body: unknown;
  contentType?: string | undefined;
  headers?: Headers | Record<string, string>;
}

export interface ContractTester {
  /** Validates a response against the OpenAPI operation responses. */
  assertResponse(
    method: string,
    path: string,
    response: ContractAssertion,
  ): { ok: true } | { ok: false; errors: string[] };
  /** Vitest-friendly helper: throws on mismatch. */
  expectResponse(method: string, path: string, response: ContractAssertion): void;
}

function pathKey(doc: OpenApiDocument, path: string): string | undefined {
  if (Object.hasOwn(doc.paths, path)) return path;
  for (const p of Object.keys(doc.paths)) {
    const source = p
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':') || /^\{.+\}$/.test(seg)) return '[^/]+';
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    if (new RegExp(`^${source}$`).test(path)) return p;
  }
  return undefined;
}

function resolveRef(
  doc: OpenApiDocument,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const ref = schema.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) return schema;
  const name = ref.slice('#/components/schemas/'.length);
  const resolved = doc.components.schemas[name];
  return (resolved as Record<string, unknown>) ?? schema;
}

/**
 * Creates a contract tester that validates responses against an OpenAPI 3.1 document
 * using Ajv (optional peer).
 */
export function createContractTester(
  openapi: OpenApiDocument,
  options: ContractTesterOptions = {},
): ContractTester {
  const ajv =
    options.instance ??
    new Ajv2020({
      allErrors: true,
      strict: false,
      validateSchema: false,
    });

  const assertResponse = (
    method: string,
    path: string,
    response: ContractAssertion,
  ): { ok: true } | { ok: false; errors: string[] } => {
    const key = pathKey(openapi, path);
    if (key === undefined) return { ok: false, errors: [`No OpenAPI path for ${path}`] };
    const op = openapi.paths[key]?.[method.toLowerCase()] as
      | {
          responses?: Record<
            string,
            { content?: Record<string, { schema?: Record<string, unknown> }> }
          >;
        }
      | undefined;
    if (!op) return { ok: false, errors: [`No OpenAPI operation ${method.toUpperCase()} ${key}`] };
    const statusKey = String(response.status);
    const resp = op.responses?.[statusKey] ?? op.responses?.default;
    if (!resp) {
      return {
        ok: false,
        errors: [`Status ${response.status} not documented for ${method} ${key}`],
      };
    }
    if (response.body === null || response.body === undefined) return { ok: true };
    const contentType =
      response.contentType ??
      (response.headers instanceof Headers
        ? (response.headers.get('content-type') ?? undefined)
        : (response.headers?.['content-type'] ?? response.headers?.['Content-Type']));
    const content = resp.content;
    if (!content) return { ok: true };
    const matched = contentType
      ? Object.entries(content).find(([ct]) => contentType.includes(ct.split(';')[0]!))?.[1]
      : undefined;
    const media = matched ?? content['application/json'] ?? Object.values(content)[0];
    const mediaSchema = media && typeof media === 'object' ? media.schema : undefined;
    if (!mediaSchema) return { ok: true };
    const schema = resolveRef(openapi, mediaSchema);
    const validate = ajv.compile(schema);
    const ok = validate(response.body);
    if (ok) return { ok: true };
    return {
      ok: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
      ),
    };
  };

  return {
    assertResponse,
    expectResponse(method, path, response) {
      const result = assertResponse(method, path, response);
      if (!result.ok) {
        throw new Error(`Contract violation: ${result.errors.join('; ')}`);
      }
    },
  };
}
