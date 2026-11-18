import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  getMessageStorage,
  type MessageStorage,
  type MessageStorageInput,
  saveMessageStorage,
  testMessageStorage,
} from '../api.js';

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

/** Original messages in the database or an R2 / S3 bucket, for platform operators. */
export function MessageStoragePanel() {
  const [state, setState] = useState<MessageStorage | null>(null);
  const [form, setForm] = useState<MessageStorageInput | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: MessageStorage, keepForm = false) => {
    setState(next);
    if (!keepForm) {
      setForm({
        kind: next.kind,
        endpoint: next.endpoint,
        region: next.region,
        bucket: next.bucket,
        prefix: next.prefix,
        accessKeyId: next.accessKeyId,
        forcePathStyle: next.forcePathStyle,
      });
    }
  }, []);

  useEffect(() => {
    void getMessageStorage()
      .then((next) => apply(next))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    // Progress of the background move.
    const timer = setInterval(() => {
      void getMessageStorage()
        .then((next) => apply(next, true))
        .catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [apply]);

  if (!state || !form) return error ? <p className="notice notice-error">{error}</p> : null;
  const input = (): MessageStorageInput => ({
    ...form,
    ...(secret.trim() ? { secretAccessKey: secret.trim() } : {}),
  });
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void action()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const onSave = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      apply(await saveMessageStorage(input()));
      setSecret('');
      setNotice(
        form.kind === 's3'
          ? 'Saved. New mail goes to the bucket, and existing messages move there in the background.'
          : 'Saved. Messages in the bucket move back into the database in the background.',
      );
    });
  };
  const set = (patch: Partial<MessageStorageInput>) => setForm({ ...form, ...patch });
  const moving =
    (state.kind === 's3' && state.inDatabase.messages > 0) ||
    (state.kind === 'database' && state.inBucket.messages > 0);

  return (
    <section className="panel">
      <h2>Message storage</h2>
      <p className="muted">
        Where the original of every message (with attachments) is kept. In a bucket (Cloudflare R2,
        Amazon S3, Backblaze B2, MinIO) the database only holds the message list, folders and
        settings, so a small hosted PostgreSQL such as Neon is enough. Every redundancy node reads
        the same bucket.
      </p>
      <p>
        In the database: {state.inDatabase.messages} messages ({megabytes(state.inDatabase.bytes)}).
        In the bucket: {state.inBucket.messages} messages ({megabytes(state.inBucket.bytes)}).
        {moving ? ' Moving in the background…' : ''}
      </p>
      {state.lastError ? (
        <p className="notice notice-error">Last move stopped: {state.lastError}</p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <form className="form-grid" onSubmit={onSave}>
        <div className="field">
          <label htmlFor="ms-kind">Store messages in</label>
          <select
            id="ms-kind"
            value={form.kind}
            onChange={(event) => set({ kind: event.target.value as MessageStorage['kind'] })}
          >
            <option value="database">The database</option>
            <option value="s3">An R2 or S3 bucket</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ms-endpoint">Endpoint</label>
          <input
            id="ms-endpoint"
            placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com"
            value={form.endpoint}
            onChange={(event) => set({ endpoint: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ms-bucket">Bucket</label>
          <input
            id="ms-bucket"
            value={form.bucket}
            onChange={(event) => set({ bucket: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ms-prefix">Folder in the bucket (optional)</label>
          <input
            id="ms-prefix"
            placeholder="aspectenant/"
            value={form.prefix}
            onChange={(event) => set({ prefix: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ms-region">Region</label>
          <input
            id="ms-region"
            value={form.region}
            onChange={(event) => set({ region: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ms-key">Access key ID</label>
          <input
            id="ms-key"
            autoComplete="off"
            value={form.accessKeyId}
            onChange={(event) => set({ accessKeyId: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ms-secret">Secret access key {state.hasSecret ? '(saved)' : ''}</label>
          <input
            id="ms-secret"
            type="password"
            autoComplete="off"
            placeholder={state.hasSecret ? 'Leave blank to keep' : ''}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.forcePathStyle}
              onChange={(event) => set({ forcePathStyle: event.target.checked })}
            />{' '}
            Path-style addresses (MinIO)
          </label>
        </div>
        <div className="field field-action">
          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>
              Save
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await testMessageStorage(input());
                  setNotice('The bucket accepted, returned and deleted a test object.');
                })
              }
            >
              Test bucket
            </button>
          </div>
        </div>
      </form>
      <p className="muted">
        For R2: create a bucket, then an R2 API token with Object Read and Write for that bucket.
        Use its access key ID and secret, with region auto. Keep the bucket (or folder) for this
        installation only: messages nothing refers to any more are deleted from it after 30 days.
        Panel backups do not contain messages kept in the bucket, so turn on a bucket backup or
        object versioning as well.
      </p>
    </section>
  );
}
