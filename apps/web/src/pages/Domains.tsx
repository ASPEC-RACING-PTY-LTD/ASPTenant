import { type FormEvent, useEffect, useState } from 'react';
import {
  createDomain,
  type DirectoryDomain,
  deleteDomain,
  listDomains,
  setPrimaryDomain,
  verifyDomain,
} from '../api.js';

export function DomainsPage() {
  const [domains, setDomains] = useState<DirectoryDomain[]>([]);
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setDomains(await listDomains());
  };

  useEffect(() => {
    void listDomains()
      .then(setDomains)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load domains.');
      });
  }, []);

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

  return (
    <>
      <div className="page-header">
        <h1>Domains</h1>
        <p>
          Register organisation domains here. Verification is operator-confirmed. Automatic DNS
          checks are not implemented.
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
              placeholder="mail.example.com"
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
                      onClick={() => {
                        void verifyDomain(domain.id)
                          .then(reload)
                          .catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : 'Verify failed.');
                          });
                      }}
                    >
                      Mark verified
                    </button>
                  ) : null}
                  {!domain.primary ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        void setPrimaryDomain(domain.id)
                          .then(reload)
                          .catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : 'Primary update failed.');
                          });
                      }}
                    >
                      Make primary
                    </button>
                  ) : null}
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      void deleteDomain(domain.id)
                        .then(reload)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Delete failed.');
                        });
                    }}
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
