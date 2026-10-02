import { useEffect, useState } from 'react';
import { applyUpdate, checkUpdates, getUpdates, setAutoUpdate, type UpdateStatus } from '../api.js';

export function UpdatesPage() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getUpdates()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!status?.updater.pending && status?.updater.state !== 'running') return;
    const timer = setInterval(() => {
      void getUpdates()
        .then(setStatus)
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [status?.updater.pending, status?.updater.state]);

  const run = async (action: () => Promise<UpdateStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return error ? <p className="notice notice-error">{error}</p> : <p>Loading…</p>;

  return (
    <>
      <div className="page-header">
        <h1>Updates</h1>
        <p>Releases are published on GitHub ({status.repository}) as versioned Docker images.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Version</h2>
        <table className="data-table">
          <tbody>
            <tr>
              <th>Installed</th>
              <td>{status.current}</td>
            </tr>
            <tr>
              <th>Latest release</th>
              <td>
                {status.latest ? (
                  <a href={status.latest.url} target="_blank" rel="noreferrer">
                    {status.latest.version}
                  </a>
                ) : (
                  'Not checked or no release yet'
                )}{' '}
                {status.updateAvailable ? (
                  <span className="badge badge-warn">Update available</span>
                ) : status.latest ? (
                  <span className="badge badge-ok">Up to date</span>
                ) : null}
              </td>
            </tr>
            <tr>
              <th>Last checked</th>
              <td>{status.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'Never'}</td>
            </tr>
            <tr>
              <th>Updater</th>
              <td>
                {status.updater.available ? (
                  <span className="badge badge-ok">Running</span>
                ) : (
                  <span className="badge badge-off">Not running</span>
                )}{' '}
                {status.updater.pending ? 'Update queued. ' : ''}
                {status.updater.state ? `Last run: ${status.updater.state}` : ''}
                {status.updater.finishedAt
                  ? ` (${new Date(status.updater.finishedAt).toLocaleString()})`
                  : ''}
              </td>
            </tr>
          </tbody>
        </table>
        {status.lastError ? <p className="notice notice-error">{status.lastError}</p> : null}
        <div className="btn-row">
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => void run(checkUpdates)}
          >
            Check for updates
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !status.updateAvailable || !status.updater.available}
            onClick={() => {
              if (!window.confirm('Install the update now? The panel restarts for a moment.'))
                return;
              void run(applyUpdate);
            }}
          >
            Update
          </button>
        </div>
        {status.latest?.notes ? <pre className="code">{status.latest.notes}</pre> : null}
      </section>
      <section className="panel">
        <h2>Automatic updates</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={status.autoUpdate}
            disabled={busy}
            onChange={(event) => void run(() => setAutoUpdate(event.target.checked))}
          />{' '}
          Install new releases automatically (checked every 6 hours)
        </label>
      </section>
      {status.updater.log ? (
        <section className="panel">
          <h2>Last update log</h2>
          <pre className="code">{status.updater.log}</pre>
        </section>
      ) : null}
    </>
  );
}
