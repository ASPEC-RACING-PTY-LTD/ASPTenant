import { afterEach, describe, expect, it } from 'vitest';
import { closePlatform } from '../src/platform.js';
import { createTestContext, json, request, setupOwner, type TestContext } from './helpers.js';

describe('redundancy nodes', () => {
  const contexts: TestContext[] = [];

  afterEach(async () => {
    // The nodes share one database; close it once, after every node has stopped.
    for (const ctx of contexts.splice(0).reverse()) {
      await ctx.platform.cluster.stop();
    }
    await closePlatformsOnce();
  });

  let closing: TestContext | null = null;
  async function closePlatformsOnce() {
    if (closing) await closePlatform(closing.platform).catch(() => undefined);
    closing = null;
  }

  /** Two nodes on one database: a (primary) and b (secondary). */
  async function twoNodes() {
    const a = await createTestContext({ env: { NODE_NAME: 'node-a', NODE_ROLE: 'primary' } });
    const b = await createTestContext({
      database: a.database,
      env: { NODE_NAME: 'node-b', NODE_ROLE: 'secondary' },
    });
    contexts.push(a, b);
    closing = a;
    return { a, b };
  }

  it('elects one leader, fails over, and hands leadership back to the primary', async () => {
    const { a, b } = await twoNodes();
    await a.platform.cluster.tick();
    await b.platform.cluster.tick();
    expect(a.platform.cluster.isLeader()).toBe(true);
    expect(b.platform.cluster.isLeader()).toBe(false);

    // The primary stops: the secondary takes over on its next heartbeat.
    await a.platform.cluster.stop();
    await b.platform.cluster.tick();
    expect(b.platform.cluster.isLeader()).toBe(true);
    let status = await b.platform.cluster.status();
    expect(status.leader).toBe('node-b');
    expect(status.term).toBeGreaterThanOrEqual(2);

    // While the secondary leads, the returning primary cannot take the lease at once.
    await a.platform.cluster.tick();
    expect(a.platform.cluster.isLeader()).toBe(false);

    // Once the primary has been up for a while, the secondary hands it back.
    await a.database.query(`UPDATE aspectenant_cluster_nodes SET started_at = $1 WHERE id = $2`, [
      Date.now() - 60_000,
      'node-a',
    ]);
    await b.platform.cluster.tick();
    expect(b.platform.cluster.isLeader()).toBe(false);
    await a.platform.cluster.tick();
    expect(a.platform.cluster.isLeader()).toBe(true);
    status = await a.platform.cluster.status();
    expect(status.nodes.map((node) => [node.id, node.preferred, node.leader])).toEqual([
      ['node-a', true, true],
      ['node-b', false, false],
    ]);
  });

  it('a lease that is not renewed expires and is taken over', async () => {
    const { a, b } = await twoNodes();
    await a.platform.cluster.tick();
    expect(a.platform.cluster.isLeader()).toBe(true);
    // The primary's machine dies without releasing the lease: it simply runs out.
    await a.database.query(`UPDATE aspectenant_cluster_lease SET expires_at = $1`, [
      Date.now() - 1,
    ]);
    await b.platform.cluster.tick();
    expect(b.platform.cluster.isLeader()).toBe(true);
    // The old leader, if it comes back, sees it lost the lease and stops leader-only work.
    await a.platform.cluster.tick();
    expect(a.platform.cluster.isLeader()).toBe(false);
  });

  it('sends signals to the other nodes only', async () => {
    const { a, b } = await twoNodes();
    const seen: string[] = [];
    a.platform.cluster.onSignal('test', () => seen.push('a'));
    b.platform.cluster.onSignal('test', () => seen.push('b'));
    await a.platform.cluster.tick();
    await b.platform.cluster.tick();
    await a.platform.cluster.signal('test');
    await a.platform.cluster.tick();
    await b.platform.cluster.tick();
    expect(seen).toEqual(['b']);
    await b.platform.cluster.signal('test');
    await a.platform.cluster.tick();
    await b.platform.cluster.tick();
    expect(seen).toEqual(['b', 'a']);
  });

  it('shows the nodes to platform operators and lets them remove offline ones', async () => {
    const { a, b } = await twoNodes();
    const cookie = await setupOwner(a);
    await a.platform.cluster.tick();
    await b.platform.cluster.tick();
    const view = await json<{ enabled: boolean; leader: string; nodes: Array<{ id: string }> }>(
      await request(a, '/api/v1/cluster', { headers: { cookie } }),
    );
    expect(view.enabled).toBe(true);
    expect(view.leader).toBe('node-a');
    expect(view.nodes.map((node) => node.id)).toEqual(['node-a', 'node-b']);

    // An online node stays; once it has been gone a while it can be removed.
    const remove = () =>
      request(a, '/api/v1/cluster/nodes/node-b', { method: 'DELETE', headers: { cookie } });
    expect((await remove()).status).toBe(422);
    await b.platform.cluster.stop();
    await a.database.query(
      `UPDATE aspectenant_cluster_nodes SET last_seen = 0 WHERE id = 'node-b'`,
    );
    expect((await remove()).status).toBe(200);

    const saved = await request(a, '/api/v1/cluster/settings', {
      method: 'PUT',
      headers: { cookie },
      body: JSON.stringify({ dnsFailover: true }),
    });
    expect(saved.status).toBe(200);
    // node-a has no NODE_ADDRESS, so the move is reported instead of attempted.
    const after = await json<{ settings: { dnsFailover: boolean; lastFailover: { ok: boolean } } }>(
      saved,
    );
    expect(after.settings.dnsFailover).toBe(true);
    expect(after.settings.lastFailover.ok).toBe(false);
  });

  it('runs a single machine as its own leader', async () => {
    const solo = await createTestContext();
    contexts.push(solo);
    closing = solo;
    expect(solo.platform.cluster.enabled).toBe(false);
    expect(solo.platform.cluster.isLeader()).toBe(true);
  });
});
