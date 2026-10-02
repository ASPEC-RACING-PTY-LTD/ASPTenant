import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type BackupJob,
  type BackupSettings,
  getBackups,
  listRemoteBackups,
  restoreBackup,
  runBackup,
  saveBackupSettings,
  testBackups,
} from '../api.js';

const size = (bytes: number) =>
  bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;

export function BackupsPage() {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [history, setHistory] = useState<BackupJob[]>([]);
  const [form, setForm] = useState<BackupSettings | null>(null);
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [remote, setRemote] = useState<Array<{
    key: string;
    size: number;
    modifiedAt: number;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const body = await getBackups();
    setSettings(body.settings);
    setForm(body.settings);
    setHistory(body.history);
  }, []);

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!settings || !form)
    return error ? <p className="notice notice-error">{error}</p> : <p>Loading…</p>;

  const set = <K extends keyof BackupSettings>(key: K, value: BackupSettings[K]) =>
    setForm({ ...form, [key]: value });

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { hasSecret: _a, hasPassphrase: _b, lastSuccessAt: _c, nextRunAt: _d, ...rest } = form;
      await saveBackupSettings({
        ...rest,
        ...(secret ? { secretAccessKey: secret } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
      setSecret('');
      setPassphrase('');
      await load();
      setNotice('Saved. Store the encryption passphrase somewhere safe: restores need it.');
    });
  };

  return (
    <>
      <div className="page-header">
        <h1>Backups</h1>
        <p>
          Encrypted backups of all data (users, settings, credentials and every mailbox message) to
          Cloudflare R2 or any S3-compatible storage.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <section className="panel">
        <h2>Status</h2>
        <p>
          {settings.enabled ? (
            <span className="badge badge-ok">Scheduled</span>
          ) : (
            <span className="badge badge-off">Off</span>
          )}{' '}
          Last success:{' '}
          {settings.lastSuccessAt ? new Date(settings.lastSuccessAt).toLocaleString() : 'never'}
          {settings.nextRunAt
            ? `. Next: ${new Date(Math.max(settings.nextRunAt, Date.now())).toLocaleString()}`
            : ''}
        </p>
        <div className="btn-row">
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const job = await runBackup();
                await load();
                setNotice(`Backup ${job.status}: ${job.data.key ?? ''}`);
              })
            }
          >
            {busy ? 'Working…' : 'Back up now'}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => void run(async () => setNotice((await testBackups()).detail))}
          >
            Test connection
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => void run(async () => setRemote(await listRemoteBackups()))}
          >
            Show backups in bucket
          </button>
        </div>
      </section>
      {remote ? (
        <section className="panel">
          <h2>Restore</h2>
          <p className="notice notice-error">
            Restoring replaces all current data with the backup. The panel restarts and everyone
            signs in again.
          </p>
          <table className="data-table">
            <tbody>
              {remote
                .slice()
                .reverse()
                .map((item) => (
                  <tr key={item.key}>
                    <td>{item.key}</td>
                    <td>{size(item.size)}</td>
                    <td>
                      <button
                        className="btn btn-danger"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.prompt(`Type RESTORE to replace all data with ${item.key}`) !==
                            'RESTORE'
                          )
                            return;
                          void run(async () => {
                            const result = await restoreBackup(item.key);
                            setNotice(
                              `Restored ${result.rows} records. Restarting, sign in again in a minute.`,
                            );
                          });
                        }}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section className="panel">
        <h2>Storage and schedule</h2>
        <form className="form-grid" onSubmit={onSave}>
          <div className="field">
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />{' '}
              Scheduled backups
            </label>
          </div>
          <div className="field">
            <label htmlFor="bk-endpoint">Endpoint</label>
            <input
              id="bk-endpoint"
              placeholder="https://<account>.r2.cloudflarestorage.com"
              value={form.endpoint}
              onChange={(e) => set('endpoint', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-region">Region</label>
            <input
              id="bk-region"
              value={form.region}
              onChange={(e) => set('region', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-bucket">Bucket</label>
            <input
              id="bk-bucket"
              value={form.bucket}
              onChange={(e) => set('bucket', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-prefix">Folder prefix</label>
            <input
              id="bk-prefix"
              value={form.prefix}
              onChange={(e) => set('prefix', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-key">Access key ID</label>
            <input
              id="bk-key"
              autoComplete="off"
              value={form.accessKeyId}
              onChange={(e) => set('accessKeyId', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-secret">
              Secret access key {settings.hasSecret ? '(saved)' : ''}
            </label>
            <input
              id="bk-secret"
              type="password"
              autoComplete="off"
              placeholder={settings.hasSecret ? 'Leave blank to keep' : ''}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-pass">
              Encryption passphrase {settings.hasPassphrase ? '(saved)' : ''}
            </label>
            <input
              id="bk-pass"
              type="password"
              autoComplete="new-password"
              placeholder={
                settings.hasPassphrase ? 'Leave blank to keep' : 'At least 12 characters'
              }
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-interval">Every (hours)</label>
            <input
              id="bk-interval"
              type="number"
              min={1}
              value={form.intervalHours}
              onChange={(e) => set('intervalHours', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="bk-keep">Keep last</label>
            <input
              id="bk-keep"
              type="number"
              min={1}
              value={form.retentionCount}
              onChange={(e) => set('retentionCount', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={(e) => set('forcePathStyle', e.target.checked)}
              />{' '}
              Path-style URLs (MinIO)
            </label>
          </div>
          <div className="field field-action">
            <button className="btn" type="submit" disabled={busy}>
              Save
            </button>
          </div>
        </form>
        <p className="muted">
          R2: create a bucket and an R2 API token with Object Read and Write, then use the S3
          endpoint and keys it shows, region auto. To recover on a new server, install ASPECTenant
          and choose Restore from backup on the setup page.
        </p>
      </section>
      <section className="panel">
        <h2>History</h2>
        <table className="data-table">
          <tbody>
            {history.map((job) => (
              <tr key={job.id}>
                <td>{new Date(job.createdAt).toLocaleString()}</td>
                <td>{job.title}</td>
                <td>
                  <span
                    className={`badge ${job.status === 'succeeded' ? 'badge-ok' : job.status === 'failed' ? 'badge-warn' : 'badge-off'}`}
                  >
                    {job.status}
                  </span>
                  {job.error ? <div className="muted">{job.error}</div> : null}
                </td>
                <td>
                  {job.progress.bytes ? size(job.progress.bytes) : ''}{' '}
                  {job.progress.rows ? `${job.progress.rows} records` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
