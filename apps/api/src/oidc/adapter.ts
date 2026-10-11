import type { SqlClient } from '@aspec/db';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { ClientRecord, OidcClients } from './clients.js';

/** Client metadata the provider reads for one application. */
export function clientMetadata(record: ClientRecord): AdapterPayload {
  const confidential = record.clientType === 'confidential';
  return {
    client_id: record.clientId,
    client_name: record.name,
    redirect_uris: record.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Public clients are desktop and mobile apps: PKCE only, loopback redirects on any port.
    application_type: confidential ? 'web' : 'native',
    token_endpoint_auth_method: confidential ? 'client_secret_basic' : 'none',
    // The provider never sees the secret itself, only its hash (see compareClientSecret).
    ...(confidential && record.secretHash ? { client_secret: record.secretHash } : {}),
    require_auth_time: true,
    id_token_signed_response_alg: 'RS256',
    post_logout_redirect_uris: record.redirectUris.filter((uri) => /^https?:/i.test(uri)),
  };
}

/**
 * SQL storage for the provider's sessions, interactions, codes, tokens and grants. Clients are
 * not stored here: they are the applications registered in each tenant.
 */
export function createAdapterFactory(
  db: SqlClient,
  clients: OidcClients,
): new (
  name: string,
) => Adapter {
  return class SqlAdapter implements Adapter {
    private readonly model: string;

    constructor(name: string) {
      this.model = name;
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
      const values = [
        JSON.stringify(payload),
        payload.grantId ?? null,
        payload.uid ?? null,
        payload.userCode ?? null,
        expiresAt,
        this.model,
        id,
      ];
      const updated = await db.query(
        `UPDATE aspectenant_oidc_store SET payload = $1, grant_id = $2, uid = $3, user_code = $4,
          expires_at = $5, consumed_at = NULL WHERE model = $6 AND id = $7`,
        values,
      );
      if (updated.rowCount === 0) {
        await db.query(
          `INSERT INTO aspectenant_oidc_store (payload, grant_id, uid, user_code, expires_at, model, id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          values,
        );
      }
    }

    private async findWhere(column: 'id' | 'uid' | 'user_code', value: string) {
      const result = await db.query(
        `SELECT payload, expires_at, consumed_at FROM aspectenant_oidc_store
         WHERE model = $1 AND ${column} = $2`,
        [this.model, value],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const expiresAt = row.expires_at === null ? null : Number(row.expires_at);
      if (expiresAt !== null && expiresAt <= Date.now()) return undefined;
      const payload = JSON.parse(String(row.payload)) as AdapterPayload;
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        payload.consumed = Math.floor(Number(row.consumed_at) / 1000);
      }
      return payload;
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.model === 'Client') {
        const record = await clients.findByClientId(id);
        return record ? clientMetadata(record) : undefined;
      }
      return this.findWhere('id', id);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return this.findWhere('uid', uid);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      return this.findWhere('user_code', userCode);
    }

    async consume(id: string): Promise<void> {
      await db.query(
        `UPDATE aspectenant_oidc_store SET consumed_at = $1 WHERE model = $2 AND id = $3`,
        [Date.now(), this.model, id],
      );
    }

    async destroy(id: string): Promise<void> {
      await db.query(`DELETE FROM aspectenant_oidc_store WHERE model = $1 AND id = $2`, [
        this.model,
        id,
      ]);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await db.query(`DELETE FROM aspectenant_oidc_store WHERE grant_id = $1`, [grantId]);
    }
  };
}

/** Removes expired provider records. */
export async function purgeExpired(db: SqlClient): Promise<number> {
  const result = await db.query(
    `DELETE FROM aspectenant_oidc_store WHERE expires_at IS NOT NULL AND expires_at < $1`,
    [Date.now()],
  );
  return result.rowCount ?? 0;
}
