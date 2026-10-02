import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyInMemory,
  buildOpenApi,
  buildPageMeta,
  createApi,
  createClient,
  created,
  decodeCursor,
  defineResource,
  defineRoute,
  encodeCursor,
  escapeHtml,
  generateClient,
  ok,
  paginated,
  parseFilterSort,
  parsePagination,
  toSql,
} from '../src/index.js';
import { createContractTester } from '../src/testing.js';

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.number().int(),
});

describe('defineRoute and createApi', () => {
  const list = defineRoute({
    method: 'get',
    path: '/items',
    operationId: 'listItems',
    summary: 'List items',
    tags: ['items'],
    request: {
      query: z.object({
        limit: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
      }),
    },
    responses: {
      '200': {
        description: 'OK',
        jsonSchema: {
          type: 'object',
          required: ['data', 'meta', 'links'],
          properties: {
            data: { type: 'array', items: { type: 'object' } },
            meta: { type: 'object' },
            links: { type: 'object' },
          },
        },
      },
    },
    handler: async ({ request }) => {
      const page = parsePagination(request.query ?? {}, { defaultLimit: 10, maxLimit: 50 });
      const rows = [
        { id: '1', name: 'A', status: 'active', createdAt: 1 },
        { id: '2', name: 'B', status: 'archived', createdAt: 2 },
      ];
      const offset = page.kind === 'offset' ? page.offset : 0;
      const slice = rows.slice(offset, offset + page.limit);
      const { meta, links } = buildPageMeta(page, slice.length, {
        baseUrl: '/items',
        total: rows.length,
      });
      return paginated(slice, meta, links);
    },
  });

  const create = defineRoute({
    method: 'post',
    path: '/items',
    operationId: 'createItem',
    request: {
      body: z.object({ name: z.string().min(1), status: z.enum(['active', 'archived']) }),
    },
    responses: { '201': { description: 'Created', schema: itemSchema } },
    handler: async ({ request }) =>
      created({ id: '9', name: request.body!.name, status: request.body!.status, createdAt: 9 }),
  });

  const get = defineRoute({
    method: 'get',
    path: '/items/:id',
    operationId: 'getItem',
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: { '200': { description: 'OK', schema: itemSchema } },
    handler: async ({ request }) =>
      ok({ id: request.params!.id, name: 'A', status: 'active' as const, createdAt: 1 }),
  });

  const api = createApi({
    info: { title: 'Items API', version: '1.0.0', description: 'Test API <script>' },
    routes: [list, create, get],
    versioning: { style: 'both', versions: ['2', '1'], defaultVersion: '1' },
  });

  it('infers OpenAPI and serves docs/openapi', async () => {
    const doc = api.openapi();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/items']?.get).toBeTruthy();
    expect(doc.paths['/items']?.post).toBeTruthy();
    const html = api.docsHtml();
    expect(html).toContain('Items API');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml('<x>')).toBe('&lt;x&gt;');

    const openapiRes = await api.handle(new Request('http://local/v1/openapi.json'));
    expect(openapiRes.status).toBe(200);
    expect(openapiRes.headers.get('API-Version')).toBe('1');
  });

  it('validates and handles routes', async () => {
    const listed = await api.handle(new Request('http://local/v1/items?limit=1'));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: unknown[]; meta: { limit: number } };
    expect(body.data).toHaveLength(1);
    expect(body.meta.limit).toBe(1);

    const createdRes = await api.handle(
      new Request('http://local/v1/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'API-Version': '1' },
        body: JSON.stringify({ name: 'Z', status: 'active' }),
      }),
    );
    expect(createdRes.status).toBe(201);

    const bad = await api.handle(
      new Request('http://local/v1/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', status: 'active' }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get('content-type')).toContain('problem+json');

    const one = await api.handle(new Request('http://local/v1/items/42'));
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: '42' });
  });

  it('emits deprecation headers when configured', async () => {
    const deprecated = defineRoute({
      method: 'get',
      path: '/legacy',
      versions: {
        max: '1',
        deprecated: {
          at: true,
          sunset: 'Sat, 01 Jan 2028 00:00:00 GMT',
          link: 'https://example.com/docs/migration',
        },
      },
      handler: async () => ok({ ok: true }),
    });
    const depApi = createApi({
      info: { title: 'D', version: '1' },
      routes: [deprecated],
      versioning: { style: 'url', versions: ['2', '1'] },
    });
    const res = await depApi.handle(new Request('http://local/v1/legacy'));
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Sunset')).toContain('2028');
    expect(res.headers.get('Link')).toContain('rel="deprecation"');
  });

  it('defineResource groups routes', () => {
    const resource = defineResource('items', { list, get, create });
    expect(resource.routes).toHaveLength(3);
    expect(resource.routes.every((r) => r.tags?.includes('items'))).toBe(true);
  });
});

describe('pagination cursors', () => {
  it('signs and rejects tampering', () => {
    const secret = 'cursor-secret-value';
    const cursor = encodeCursor({ p: 10, i: 'a' }, secret);
    expect(decodeCursor(cursor, secret)).toEqual({ p: 10, i: 'a' });
    const tampered = `${cursor.slice(0, -2)}aa`;
    expect(() => decodeCursor(tampered, secret)).toThrow(/cursor/i);
  });
});

describe('filter/sort', () => {
  const whitelist = {
    status: { column: 'status', operators: ['eq', 'ne', 'in'] as const },
    createdAt: {
      column: 'created_at',
      operators: ['gte', 'lte', 'gt', 'lt'] as const,
      coerce: (s: string) => Number(s),
    },
    name: { column: 'name', operators: ['contains', 'startsWith', 'eq'] as const },
  };

  it('parses query and rejects unknown fields', () => {
    const ast = parseFilterSort(
      new URLSearchParams('filter[status]=active&filter[createdAt][gte]=10&sort=-createdAt,name'),
      whitelist,
    );
    expect(ast.filters).toEqual([
      { field: 'status', op: 'eq', value: 'active' },
      { field: 'createdAt', op: 'gte', value: 10 },
    ]);
    expect(ast.sort).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
    expect(() => parseFilterSort(new URLSearchParams('filter[password]=x'), whitelist)).toThrow(
      /Unknown filter field/,
    );
  });

  it('builds parameterised SQL and blocks injection via identifiers', () => {
    const ast = parseFilterSort(
      new URLSearchParams("filter[name][contains]=a'; drop table items;--&sort=-createdAt"),
      whitelist,
    );
    const frag = toSql(ast, whitelist, 'sqlite');
    expect(frag.sql).toMatch(/WHERE/);
    expect(frag.sql).not.toMatch(/drop table/i);
    expect(frag.params).toContain("%a'; drop table items;--%");
  });

  it('filters in memory', () => {
    const rows = [
      { status: 'active', createdAt: 1, name: 'a' },
      { status: 'archived', createdAt: 2, name: 'b' },
    ];
    const ast = parseFilterSort(
      new URLSearchParams('filter[status]=active&sort=-createdAt'),
      whitelist,
    );
    expect(applyInMemory(rows, ast)).toEqual([rows[0]]);
  });
});

describe('contract tester and client', () => {
  it('validates responses and generates a working client', async () => {
    const route = defineRoute({
      method: 'get',
      path: '/ping',
      operationId: 'ping',
      responses: {
        '200': {
          description: 'OK',
          jsonSchema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
      },
      handler: async () => ok({ ok: true }),
    });
    const api = createApi({ info: { title: 'P', version: '1' }, routes: [route] });
    const doc = buildOpenApi({ info: { title: 'P', version: '1' }, routes: [route] });
    const tester = createContractTester(doc);
    const res = await api.handle(new Request('http://local/ping'));
    const body = await res.json();
    tester.expectResponse('get', '/ping', {
      status: res.status,
      body,
      contentType: res.headers.get('content-type') ?? undefined,
    });
    expect(tester.assertResponse('get', '/ping', { status: 200, body: { ok: 'no' } }).ok).toBe(
      false,
    );

    const source = generateClient(doc, { name: 'PingClient' });
    expect(source).toContain('export class PingClient');
    expect(source).toContain('ping');

    const client = createClient(api.routes, {
      baseUrl: 'http://local',
      fetch: (input, init) => api.handle(new Request(input, init)),
    });
    const clientRes = await client.get('/ping');
    expect(clientRes.status).toBe(200);
  });
});
