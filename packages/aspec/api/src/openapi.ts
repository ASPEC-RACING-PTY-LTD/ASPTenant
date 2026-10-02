import type { AnyRoute } from './route.js';
import { schemaToJsonSchema } from './schema-json.js';

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name: string; url?: string };
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Record<string, unknown>;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

export interface BuildOpenApiOptions {
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  routes: readonly AnyRoute[];
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  tags?: { name: string; description?: string }[];
  /** Include standard problem+json response component. Default true. */
  problemDetails?: boolean;
}

const PROBLEM_SCHEMA = {
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    correlationId: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
          pointer: { type: 'string' },
          message: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
  additionalProperties: true,
};

/** Builds an OpenAPI 3.1 document from defined routes. */
export function buildOpenApi(options: BuildOpenApiOptions): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  if (options.problemDetails !== false) {
    schemas.ProblemDetails = PROBLEM_SCHEMA;
  }

  for (const route of options.routes) {
    let pathItem = paths[route.path];
    if (pathItem === undefined) {
      pathItem = {};
      paths[route.path] = pathItem;
    }
    const operation: Record<string, unknown> = {
      responses: {},
    };
    if (route.operationId) operation.operationId = route.operationId;
    if (route.summary) operation.summary = route.summary;
    if (route.description) operation.description = route.description;
    if (route.tags) operation.tags = [...route.tags];
    if (route.deprecated || route.versions?.deprecated) operation.deprecated = true;
    if (route.security)
      operation.security = route.security.map((s) => (typeof s === 'string' ? { [s]: [] } : s));

    const parameters: Record<string, unknown>[] = [];
    addParams(parameters, 'path', route.request.params, route.jsonSchema?.params, route.path);
    addParams(parameters, 'query', route.request.query, route.jsonSchema?.query);
    addParams(parameters, 'header', route.request.headers, route.jsonSchema?.headers);
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.request.body || route.jsonSchema?.body) {
      const bodySchema = route.jsonSchema?.body ??
        schemaToJsonSchema(route.request.body) ?? { type: 'object' };
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: bodySchema } },
      };
    }

    const responses = operation.responses as Record<string, unknown>;
    for (const [status, spec] of Object.entries(route.responses)) {
      const schema = spec.jsonSchema ?? schemaToJsonSchema(spec.schema);
      const content = schema === undefined ? undefined : { 'application/json': { schema } };
      const resp: Record<string, unknown> = {
        description: spec.description ?? status,
      };
      if (content) resp.content = content;
      if (spec.headers) resp.headers = spec.headers;
      responses[status] = resp;
    }
    if (options.problemDetails !== false && responses['400'] === undefined) {
      responses['400'] = {
        description: 'Bad Request',
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        },
      };
    }
    pathItem[route.method] = operation;
  }

  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: options.info,
    paths,
    components: { schemas },
  };
  if (options.servers) doc.servers = options.servers;
  if (options.tags) doc.tags = options.tags;
  if (options.securitySchemes) {
    doc.components.securitySchemes = options.securitySchemes;
  }
  return doc;
}

function addParams(
  out: Record<string, unknown>[],
  location: 'path' | 'query' | 'header',
  schema: unknown,
  override?: Record<string, unknown>,
  path?: string,
): void {
  const json = override ?? schemaToJsonSchema(schema as never);
  if (!json || typeof json !== 'object') {
    if (location === 'path' && path) {
      for (const name of pathParams(path)) {
        out.push({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
      }
    }
    return;
  }
  const props = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  for (const [name, propSchema] of Object.entries(props)) {
    out.push({
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      schema: propSchema,
    });
  }
  if (location === 'path' && path) {
    for (const name of pathParams(path)) {
      if (!Object.hasOwn(props, name)) {
        out.push({ name, in: 'path', required: true, schema: { type: 'string' } });
      }
    }
  }
}

function pathParams(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    names.push(match[1] ?? match[2]!);
  }
  return names;
}

/** Escapes text for safe inclusion in an HTML document (CSP-friendly, no CDN). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders a self-contained HTML API reference page (no external scripts or stylesheets). */
export function renderDocsHtml(doc: OpenApiDocument): string {
  const title = escapeHtml(doc.info.title);
  const version = escapeHtml(doc.info.version);
  const description = doc.info.description ? `<p>${escapeHtml(doc.info.description)}</p>` : '';
  const operations: string[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const o = op as {
        summary?: string;
        description?: string;
        operationId?: string;
        deprecated?: boolean;
      };
      operations.push(`
<section class="op">
  <h2><span class="m">${escapeHtml(method.toUpperCase())}</span> <code>${escapeHtml(path)}</code></h2>
  ${o.deprecated ? '<p class="dep">Deprecated</p>' : ''}
  ${o.summary ? `<p class="sum">${escapeHtml(o.summary)}</p>` : ''}
  ${o.description ? `<p>${escapeHtml(o.description)}</p>` : ''}
  ${o.operationId ? `<p class="id">operationId: ${escapeHtml(o.operationId)}</p>` : ''}
</section>`);
    }
  }
  const json = escapeHtml(JSON.stringify(doc, null, 2));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<title>${title} ${version}</title>
<style>
:root { color-scheme: light; --fg:#14213d; --muted:#4a5568; --bg:#f7fafc; --card:#fff; --accent:#0b6e4f; --line:#e2e8f0; }
body { margin:0; font:16px/1.5 Georgia, "Times New Roman", serif; color:var(--fg); background:linear-gradient(180deg,#eef5f1,var(--bg)); }
header { padding:2.5rem 1.5rem 1rem; max-width:52rem; margin:0 auto; }
h1 { font-family: "Segoe UI", system-ui, sans-serif; font-size:2rem; margin:0 0 .25rem; letter-spacing:-0.02em; }
.ver { color:var(--muted); font-family: ui-monospace, monospace; }
main { max-width:52rem; margin:0 auto; padding:0 1.5rem 3rem; }
.op { background:var(--card); border:1px solid var(--line); padding:1rem 1.25rem; margin:0 0 1rem; }
.m { display:inline-block; min-width:4.5rem; font-family:ui-monospace,monospace; font-size:.85rem; color:var(--accent); font-weight:700; }
code { font-family:ui-monospace,monospace; }
.dep { color:#9b2c2c; font-weight:700; }
.sum { font-weight:600; }
.id { color:var(--muted); font-size:.9rem; }
details { margin-top:2rem; }
pre { overflow:auto; background:#0f172a; color:#e2e8f0; padding:1rem; font-size:.8rem; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <div class="ver">v${version}</div>
  ${description}
</header>
<main>
${operations.join('\n')}
<details>
  <summary>OpenAPI document</summary>
  <pre>${json}</pre>
</details>
</main>
</body>
</html>`;
}
