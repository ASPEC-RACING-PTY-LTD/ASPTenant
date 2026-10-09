import { type FormEvent, useEffect, useState } from 'react';
import {
  confirmDomain,
  createDomain,
  type DirectoryDomain,
  deleteDomain,
  listDomains,
  setPrimaryDomain,
  verifyDomain,
} from '../api.js';

export function DomainsPage() {
  const [domains, setDomains] = useState<DirectoryDomain[]>([]);
  const [canOverride, setCanOverride] = useState(false);
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = (result: { items: DirectoryDomain[]; canOverride: boolean }) => {
    setDomains(result.items);
    setCanOverride(result.canOverride);
  };

  const reload = async () => {
    apply(await listDomains());
  };

  useEffect(() => {
    void listDomains()
      .then((result) => {
        setDomains(result.items);
        setCanOverride(result.canOverride);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load domains.');
      });
  }, []);

  const run = (action: () => Promise<void>, fallback: string) => {
    setError(null);
    void action()
      .then(reload)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : fallback);
      });
  };

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await createDomain(hostname.trim());
      setHostname('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the domain.');
    }
  };

  const pending = domains.filter((domain) => domain.verification);

  return (
    <>
      <div className="page-header">
        <h1>Domains</h1>
        <p>
          Domains this organisation uses for mail. Prove ownership with a DNS TXT record. A verified
          domain belongs to this organisation only, and mailbox addresses must use one.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Add domain</h2>
        <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
          <div className="field">
            <label htmlFor="hostname">Hostname</label>
            <input
              id="hostname"
              placeholder="example.com"
              required
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </div>
          <div className="field field-action">
            <button className="btn" type="submit">
              Add domain
            </button>
          </div>
        </form>
      </section>
      {pending.length > 0 ? (
        <section className="panel">
          <h2>DNS records to publish</h2>
          <p>Add each record at your DNS provider, wait for it to propagate, then choose Verify.</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((domain) => (
                <tr key={domain.id}>
                  <td>{domain.hostname}</td>
                  <td>{domain.verification?.type}</td>
                  <td className="dns-record">{domain.verification?.name}</td>
                  <td className="dns-record">{domain.verification?.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section className="panel">
        <h2>Registered domains</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td>
                  {domain.hostname}
                  {domain.primary ? ' (primary)' : ''}
                </td>
                <td>
                  <span
                    className={`badge ${domain.status === 'verified' ? 'badge-ok' : 'badge-warn'}`}
                  >
                    {domain.status}
                  </span>
                </td>
                <td className="btn-row">
                  {domain.status !== 'verified' ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => run(() => verifyDomain(domain.id), 'Verification failed.')}
                    >
                      Verify
                    </button>
                  ) : null}
                  {domain.status !== 'verified' && canOverride ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      title="Platform operator override. Use only when DNS cannot be checked from this server."
                      onClick={() => run(() => confirmDomain(domain.id), 'Confirm failed.')}
                    >
                      Confirm without DNS
                    </button>
                  ) : null}
                  {!domain.primary ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() =>
                        run(() => setPrimaryDomain(domain.id), 'Primary update failed.')
                      }
                    >
                      Make primary
                    </button>
                  ) : null}
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => run(() => deleteDomain(domain.id), 'Delete failed.')}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
