import { createDatabase } from '@aspec/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindTenant, rowLevelSecurityStatus } from '../src/tenancy.js';
import {
  addVerifiedDomain,
  createTestContext,
  destroyTestContext,
  json,
  request,
  resetPostgres,
  type TestContext,
  twoTenants,
} from './helpers.js';

/**
 * Row-level security only exists in PostgreSQL. Set ASPECTENANT_TEST_DATABASE_URL to a database
 * the non-superuser application role owns (see deploy/postgres/app-role.sql). The suite drops
 * every table that role owns before it starts.
 */
const url = process.env.ASPECTENANT_TEST_DATABASE_URL;

describe.skipIf(!url)(
  'PostgreSQL tenant isolation (requires ASPECTENANT_TEST_DATABASE_URL)',
  () => {
    let ctx: TestContext;
    let tenants: Awaited<ReturnType<typeof twoTenants>>;

    beforeAll(async () => {
      const reset = await createDatabase({ url: url ?? '' });
      await resetPostgres(reset);
      await reset.close();
      ctx = await createTestContext({ database: await createDatabase({ url: url ?? '' }) });
      tenants = await twoTenants(ctx);
    });

    afterAll(async () => {
      if (ctx) await destroyTestContext(ctx);
    });

    it('connects as a role that row-level security applies to', async () => {
      const status = await rowLevelSecurityStatus(ctx.database);
      expect(status).toMatchObject({ policies: true, enforced: true });
      const system = await json<{ isolation: { rowLevelSecurity: { enforced: boolean } } }>(
        await request(ctx, '/api/v1/system', { headers: { cookie: tenants.alice } }),
      );
      expect(system.isolation.rowLevelSecurity.enforced).toBe(true);
    });

    it('hides every directory row when no tenant is bound', async () => {
      for (const cookie of [tenants.alice, tenants.bob]) {
        const created = await request(ctx, '/api/v1/groups', {
          method: 'POST',
          headers: { cookie },
          body: JSON.stringify({ name: 'Operations', kind: 'security' }),
        });
        expect(created.status).toBe(201);
      }
      const unbound = await ctx.database.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM aspectenant_groups`,
      );
      expect(Number(unbound.rows[0]?.n)).toBe(0);
    });

    it('shows and changes only the bound tenant rows, even without a tenant filter', async () => {
      const { tenantA, tenantB } = tenants;
      await ctx.database.transaction(async (tx) => {
        await bindTenant(tx, tenantA);
        const rows = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM aspectenant_groups`,
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(new Set(rows.rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA]));

        // An UPDATE with no WHERE clause cannot reach the other tenant.
        await tx.query(`UPDATE aspectenant_groups SET description = 'touched'`);
      });
      await ctx.database.transaction(async (tx) => {
        await bindTenant(tx, tenantB);
        const rows = await tx.query<{ description: string | null }>(
          `SELECT description FROM aspectenant_groups`,
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(rows.rows.every((row) => row.description !== 'touched')).toBe(true);
      });
    });

    it('refuses to write a row for another tenant', async () => {
      const { tenantA, tenantB } = tenants;
      await expect(
        ctx.database.transaction(async (tx) => {
          await bindTenant(tx, tenantA);
          await tx.query(
            `INSERT INTO aspectenant_groups (id, tenant_id, name, slug, kind, description, created_at, updated_at)
           VALUES ('cross-tenant', $1, 'Planted', 'planted', 'security', NULL, 0, 0)`,
            [tenantB],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it('keeps a verified domain with one tenant when the other cannot see it', async () => {
      const { alice, bob } = tenants;
      const pending = await json<{ id: string; verification: { name: string; value: string } }>(
        await request(ctx, '/api/v1/domains', {
          method: 'POST',
          headers: { cookie: bob },
          body: JSON.stringify({ hostname: 'contoso.test' }),
        }),
      );
      await addVerifiedDomain(ctx, { cookie: alice }, 'contoso.test');
      ctx.dns.set(pending.verification.name, [pending.verification.value]);
      // Row-level security hides Contoso's row from Fabrikam; the unique index still refuses.
      const stolen = await request(ctx, `/api/v1/domains/${pending.id}/verify`, {
        method: 'POST',
        headers: { cookie: bob },
      });
      expect(stolen.status).toBe(409);
      // The request transaction stays usable after the refused write.
      const list = await request(ctx, '/api/v1/domains', { headers: { cookie: bob } });
      expect(list.status).toBe(200);

      const mailbox = await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ kind: 'shared', primaryAddress: 'help@contoso.test' }),
      });
      expect(mailbox.status).toBe(201);
      const bobBoxes = await json<{ items: unknown[] }>(
        await request(ctx, '/api/v1/mailboxes', { headers: { cookie: bob } }),
      );
      expect(bobBoxes.items).toHaveLength(0);
    });
  },
);
