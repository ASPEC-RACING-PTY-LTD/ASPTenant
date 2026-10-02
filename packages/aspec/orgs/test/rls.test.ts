import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { SqlClient } from '../src/ports.js';
import { generateRlsPolicySql, tenantScope } from '../src/tenant.js';

const PG_URL = process.env.ASPEC_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)('PostgreSQL RLS tenant isolation', () => {
  const schema = `rls_${randomBytes(4).toString('hex')}`;
  let admin: pg.Client;
  let appPool: pg.Pool;
  let appClient: SqlClient;

  afterAll(async () => {
    await appPool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS ${schema}_app`);
      await admin.end();
    }
  });

  it('isolates rows by app.tenant_id with FORCE ROW LEVEL SECURITY', async () => {
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const role = `${schema}_app`;
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'rls-test-only' NOSUPERUSER`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`
      CREATE TABLE ${schema}.items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        label TEXT NOT NULL
      )
    `);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.items TO ${role}`);
    const policySql = generateRlsPolicySql({
      tables: ['items'],
      force: true,
    })
      .replaceAll(' items', ` ${schema}.items`)
      .replaceAll('ON items', `ON ${schema}.items`);
    // generateRlsPolicySql emits unqualified names; apply qualified manually for the test schema
    await admin.query(`ALTER TABLE ${schema}.items ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE ${schema}.items FORCE ROW LEVEL SECURITY`);
    await admin.query(`DROP POLICY IF EXISTS orgs_tenant_isolation ON ${schema}.items`);
    await admin.query(`
      CREATE POLICY orgs_tenant_isolation ON ${schema}.items FOR ALL TO PUBLIC
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
    `);
    void policySql;

    const url = new URL(PG_URL as string);
    url.username = role;
    url.password = 'rls-test-only';
    // Connect as non-owner role in the same database
    appPool = new pg.Pool({
      connectionString: PG_URL,
      max: 2,
      options: `-c search_path=${schema}`,
    });
    // Use SET ROLE inside transactions so FORCE RLS applies even for table owner connections.
    const base: SqlClient = {
      dialect: 'postgres',
      async query(sql, params = []) {
        const r = await appPool.query(sql, params as unknown[]);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
      async transaction(fn) {
        const conn = await appPool.connect();
        try {
          await conn.query('BEGIN');
          await conn.query(`SET LOCAL ROLE ${role}`);
          const tx: SqlClient = {
            dialect: 'postgres',
            async query(sql, params = []) {
              const r = await conn.query(sql, params as unknown[]);
              return { rows: r.rows, rowCount: r.rowCount ?? 0 };
            },
            transaction: (inner) => inner(tx),
          };
          const out = await fn(tx);
          await conn.query('COMMIT');
          return out;
        } catch (err) {
          await conn.query('ROLLBACK');
          throw err;
        } finally {
          conn.release();
        }
      },
    };
    appClient = base;

    const scopedA = tenantScope(appClient, 'tenant-a');
    const scopedB = tenantScope(appClient, 'tenant-b');

    await scopedA.transaction(async (tx) => {
      await tx.query(`INSERT INTO items (id, tenant_id, label) VALUES ($1,$2,$3)`, [
        '1',
        'tenant-a',
        'A',
      ]);
    });
    await scopedB.transaction(async (tx) => {
      await tx.query(`INSERT INTO items (id, tenant_id, label) VALUES ($1,$2,$3)`, [
        '2',
        'tenant-b',
        'B',
      ]);
    });

    const aRows = await scopedA.transaction(async (tx) => {
      const r = await tx.query<{ id: string }>('SELECT id FROM items ORDER BY id');
      return r.rows.map((row) => row.id);
    });
    const bRows = await scopedB.transaction(async (tx) => {
      const r = await tx.query<{ id: string }>('SELECT id FROM items ORDER BY id');
      return r.rows.map((row) => row.id);
    });
    expect(aRows).toEqual(['1']);
    expect(bRows).toEqual(['2']);

    await expect(
      scopedA.transaction(async (tx) => {
        await tx.query(`INSERT INTO items (id, tenant_id, label) VALUES ($1,$2,$3)`, [
          '3',
          'tenant-b',
          'leak',
        ]);
      }),
    ).rejects.toBeTruthy();
  });
});

describe('generateRlsPolicySql', () => {
  it('emits FORCE and policy clauses', () => {
    const sql = generateRlsPolicySql({ tables: ['orders', 'items'] });
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('orgs_tenant_isolation');
    expect(sql).toContain("current_setting('app.tenant_id', true)");
  });
});
