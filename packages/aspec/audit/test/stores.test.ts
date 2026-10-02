import { describe, expect, it } from 'vitest';
import { createAuditLogger } from '../src/logger.js';
import { createMemoryAuditStore } from '../src/stores/memory.js';
import { createSqlAuditStore, migrate } from '../src/stores/sql.js';
import { createPostgresClient, createSqliteClient } from './helpers/sql.js';

async function exerciseStore(
  label: string,
  create: () => Promise<{
    audit: ReturnType<typeof createAuditLogger>;
    close: () => Promise<void> | void;
  }>,
) {
  describe(label, () => {
    it('records, queries, counts and verifies', async () => {
      const { audit, close } = await create();
      try {
        await audit.record({
          action: 'users.create',
          actor: { id: 'a1' },
          resource: { type: 'user', id: 'u1' },
          tenantId: 't1',
          category: 'data',
        });
        await audit.record({
          action: 'users.delete',
          actor: { id: 'a2' },
          resource: { type: 'user', id: 'u2' },
          tenantId: 't1',
          outcome: 'failure',
          category: 'data',
        });
        await audit.record({
          action: 'auth.login.success',
          actor: { id: 'a1' },
          category: 'security',
        });

        const page = await audit.query({
          tenantId: 't1',
          category: 'data',
          order: 'asc',
          limit: 10,
        });
        expect(page.events).toHaveLength(2);
        expect(page.events[0]?.action).toBe('users.create');

        const byActor = await audit.query({ actorId: 'a1', order: 'desc' });
        expect(byActor.events.every((e) => e.actor?.id === 'a1')).toBe(true);

        const prefix = await audit.query({ actionPrefix: 'users.' });
        expect(prefix.events).toHaveLength(2);

        const byResource = await audit.query({ resourceType: 'user', resourceId: 'u2' });
        expect(byResource.events).toHaveLength(1);

        expect(await audit.count({ outcome: 'failure' })).toBe(1);
        expect(await audit.count({ category: 'security' })).toBe(1);

        const reports = await audit.verifyAll();
        expect(reports.every((r) => r.ok)).toBe(true);
      } finally {
        await close();
      }
    });

    it('paginates with cursors', async () => {
      const { audit, close } = await create();
      try {
        for (let i = 0; i < 5; i++) {
          await audit.record({ action: 'jobs.tick', metadata: { i }, category: 'system' });
        }
        const first = await audit.query({ category: 'system', order: 'asc', limit: 2 });
        expect(first.events).toHaveLength(2);
        expect(first.nextCursor).toBeTruthy();
        const second = await audit.query({
          category: 'system',
          order: 'asc',
          limit: 2,
          cursor: first.nextCursor as string,
        });
        expect(second.events).toHaveLength(2);
        expect(second.events[0]?.id).not.toBe(first.events[0]?.id);
      } finally {
        await close();
      }
    });
  });
}

await exerciseStore('memory store', async () => {
  const store = createMemoryAuditStore();
  return { audit: createAuditLogger({ sink: store }), close: () => undefined };
});

await exerciseStore('sqlite store', async () => {
  const client = createSqliteClient();
  await migrate(client);
  const store = createSqlAuditStore(client);
  return {
    audit: createAuditLogger({ sink: store }),
    close: () => client.close(),
  };
});

const pgUrl = process.env.ASPEC_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('postgres store', () => {
  it('records, queries and verifies under concurrent appends', async () => {
    const client = await createPostgresClient(pgUrl as string);
    try {
      await migrate(client);
      const store = createSqlAuditStore(client);
      const audit = createAuditLogger({ sink: store });
      const version = await client.query<{ server_version: string }>('SHOW server_version');
      expect(version.rows[0]?.server_version).toMatch(/^17\./);

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          audit.record({ action: 'auth.login.success', metadata: { i } }),
        ),
      );
      expect(await audit.count({ stream: 'security' })).toBe(20);
      const report = await audit.verifyChain('security');
      expect(report.ok).toBe(true);
      const seqs = (await audit.query({ stream: 'security', order: 'asc', limit: 100 })).events.map(
        (e) => e.seq,
      );
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    } finally {
      await client.close();
    }
  });
});

describe('sqlite concurrent appends', () => {
  it('serialises writers on one stream', async () => {
    const client = createSqliteClient();
    try {
      await migrate(client);
      const store = createSqlAuditStore(client);
      const audit = createAuditLogger({ sink: store });
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          audit.record({ action: 'auth.login.success', metadata: { i } }),
        ),
      );
      expect(await audit.count({})).toBe(15);
      expect((await audit.verifyChain('security')).ok).toBe(true);
    } finally {
      client.close();
    }
  });
});
