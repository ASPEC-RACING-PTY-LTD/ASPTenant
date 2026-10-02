import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAll, createMockServer, createTestClient, mockFetch, reply } from '../src/index.js';

afterEach(async () => {
  await cleanupAll();
});

describe('mockFetch', () => {
  it('matches routes, records calls, restores fetch and enforces strict mode', async () => {
    const previous = globalThis.fetch;
    const mock = mockFetch();
    mock.get('https://api.test/users/:id', reply.json({ id: '1' }));
    mock.post('https://api.test/users', (req) =>
      reply.json({ created: req.body }, { status: 201 }),
    );

    const res = await fetch('https://api.test/users/1');
    expect(await res.json()).toEqual({ id: '1' });
    const created = await fetch('https://api.test/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(created.status).toBe(201);
    expect(mock.calls).toHaveLength(2);

    await expect(fetch('https://api.test/missing')).rejects.toThrow(/no route matched/);
    mock.assertAllCalled();
    mock.restore();
    expect(globalThis.fetch).toBe(previous);
  });

  it('supports network errors and delay', async () => {
    using mock = mockFetch();
    mock.get('https://api.test/err', reply.networkError('boom'));
    await expect(fetch('https://api.test/err')).rejects.toThrow(/fetch failed/);
  });
});

describe('createMockServer', () => {
  it('serves the same route API on a real local port', async () => {
    await using server = await createMockServer();
    server.get('/ping', reply.json({ ok: true }));
    server.post('/echo', (req) => reply.json({ body: req.body }));

    const client = createTestClient(server.url);
    await client.get('/ping').expect(200).expectJson({ ok: true });
    await client
      .post('/echo')
      .send({ x: 1 })
      .expectJson({ body: { x: 1 } });
    server.assertAllCalled();
  });
});
