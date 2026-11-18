import { useCallback, useEffect, useState } from 'react';
import { type ClusterStatus, forgetClusterNode, getCluster, saveClusterSettings } from '../api.js';

const ago = (time: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(time).toLocaleString();
};

/** Redundancy nodes sharing this installation's database, for platform operators. */
export function ClusterPanel() {
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setCluster(await getCluster());
  }, []);

  useEffect(() => {
    const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
    void load().catch(fail);
    const timer = setInterval(() => void load().catch(() => undefined), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const run = (action: () => Promise<ClusterStatus>) => {
    setBusy(true);
    setError(null);
    void action()
      .then(setCluster)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  if (!cluster) return error ? <p className="notice notice-error">{error}</p> : null;
  const last = cluster.settings.lastFailover;

  return (
    <section className="panel">
      <h2>Redundancy nodes</h2>
      <p className="muted">
        Machines running this installation against the same database. Every node serves the panel,
        mail apps and inbound mail; the leader also runs backups, certificate renewal, mailbox
        imports and update checks. If the leader stops, another node takes over within about 20
        seconds, and the primary takes leadership back once it has been up for 30 seconds.
        {cluster.enabled ? '' : ' This machine runs on its own (NODE_ROLE is not set).'}
      </p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Role</th>
            <th>Status</th>
            <th>Version</th>
            <th>Address</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cluster.nodes.map((node) => (
            <tr key={node.id}>
              <td>
                {node.id}
                {node.self ? <span className="muted"> (this page)</span> : null}
              </td>
              <td>
                {node.preferred ? 'Primary' : 'Secondary'}
                {node.leader ? (
                  <>
                    {' '}
                    <span className="badge badge-ok">Leader</span>
                  </>
                ) : null}
              </td>
              <td>
                {node.online ? (
                  <span className="badge badge-ok">Online</span>
                ) : (
                  <span className="badge badge-off">Offline</span>
                )}{' '}
                <span className="muted">{ago(node.lastSeen)}</span>
              </td>
              <td>{node.version}</td>
              <td>{node.address ?? <span className="muted">not set</span>}</td>
              <td>
                {!node.online && !node.self ? (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Remove ${node.id} from the list?`)) return;
                      run(() => forgetClusterNode(node.id));
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cluster.leader === null ? (
        <p className="notice notice-error">No node leads right now. One takes over shortly.</p>
      ) : null}
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={cluster.settings.dnsFailover}
          disabled={busy}
          onChange={(event) =>
            run(() => saveClusterSettings({ dnsFailover: event.target.checked }))
          }
        />{' '}
        Move the mail apps hostname to the leading node (Cloudflare DNS, uses the Mail apps token
        and each node's NODE_ADDRESS)
      </label>
      {last ? (
        <p className={last.ok ? 'muted' : 'notice notice-error'}>
          Last move by {last.node} {ago(last.at)}: {last.detail}
        </p>
      ) : null}
      <p className="muted">
        The panel and inbound mail need no DNS change when every node runs a connector of the same
        Cloudflare Tunnel. Add a node with install.sh, option "Add this machine as a redundancy
        node".
      </p>
    </section>
  );
}
