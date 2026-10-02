import { randomUUID } from 'node:crypto';
import type { SqlClient } from '@aspec/db';

export type JobStatus = 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job<D = Record<string, unknown>, P = Record<string, unknown>> {
  id: string;
  tenantId: string;
  kind: string;
  status: JobStatus;
  title: string;
  data: D;
  progress: P;
  error: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

type Row = Record<string, unknown>;
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value));

function toJob<D, P>(row: Row): Job<D, P> {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    kind: String(row.kind),
    status: String(row.status) as JobStatus,
    title: String(row.title),
    data: JSON.parse(String(row.data)) as D,
    progress: JSON.parse(String(row.progress)) as P,
    error: row.error ? String(row.error) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined ? null : num(row.finished_at),
  };
}

/** Durable background job records (imports, backups, restores). */
export class JobStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async create<D, P>(input: {
    tenantId: string;
    kind: string;
    status: JobStatus;
    title: string;
    data: D;
    progress: P;
    createdBy: string | null;
  }): Promise<Job<D, P>> {
    const id = randomUUID();
    const now = Date.now();
    await this.db.query(
      `INSERT INTO aspectenant_jobs (id, tenant_id, kind, status, title, data, progress, error,
        created_by, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $9, NULL)`,
      [
        id,
        input.tenantId,
        input.kind,
        input.status,
        input.title,
        JSON.stringify(input.data),
        JSON.stringify(input.progress),
        input.createdBy,
        now,
      ],
    );
    const job = await this.get<D, P>(id);
    if (!job) throw new Error('Job was not stored');
    return job;
  }

  async get<D, P>(id: string): Promise<Job<D, P> | null> {
    const result = await this.db.query(`SELECT * FROM aspectenant_jobs WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? toJob<D, P>(row) : null;
  }

  async list<D, P>(kind: string, limit = 50): Promise<Job<D, P>[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_jobs WHERE kind = $1 ORDER BY created_at DESC LIMIT $2`,
      [kind, limit],
    );
    return result.rows.map((row) => toJob<D, P>(row));
  }

  async withStatus<D, P>(kind: string, statuses: JobStatus[]): Promise<Job<D, P>[]> {
    const all = await this.list<D, P>(kind, 500);
    return all.filter((job) => statuses.includes(job.status)).reverse();
  }

  async update(
    id: string,
    patch: { status?: JobStatus; data?: unknown; progress?: unknown; error?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.status) {
      add('status', patch.status);
      if (['succeeded', 'failed', 'cancelled'].includes(patch.status))
        add('finished_at', Date.now());
    }
    if (patch.data !== undefined) add('data', JSON.stringify(patch.data));
    if (patch.progress !== undefined) add('progress', JSON.stringify(patch.progress));
    if (patch.error !== undefined) add('error', patch.error);
    add('updated_at', Date.now());
    params.push(id);
    await this.db.query(
      `UPDATE aspectenant_jobs SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM aspectenant_jobs WHERE id = $1`, [id]);
  }
}
