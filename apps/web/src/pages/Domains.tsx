import { type FormEvent, useEffect, useState } from 'react';
import {
  createDomain,
  type DirectoryDomain,
  type DomainDns,
  deleteDomain,
  getDomainDns,
  listDomains,
  setPrimaryDomain,
  verifyDomain,
} from '../api.js';

export function DomainsPage() {
  const [domains, setDomains] = useState<DirectoryDomain[]>([]);
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dns, setDns] = useState<{ id: string; hostname: string; report: DomainDns } | null>(null);
  const checkDns = (domain: DirectoryDomain) => {
    setError(null);
    void getDomainDns(domain.id)
      .then((report) => setDns({ id: domain.id, hostname: domain.hostname, report }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'DNS check failed.'));
  };

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
          Add the domains you receive mail on (for example example.com). Mailboxes, aliases and
          group addresses must use one of these domains. Verify ownership with a DNS TXT record.
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
                  <button className="btn btn-ghost" type="button" onClick={() => checkDns(domain)}>
                    DNS
                  </button>
                  {domain.status !== 'verified' ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        void verifyDomain(domain.id)
                          .then(reload)
                          .catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : 'Verify failed.');
                            checkDns(domain);
                          });
                      }}
                    >
                      Verify
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
                      if (!window.confirm(`Remove ${domain.hostname}?`)) return;
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
      {dns ? (
        <section className="panel">
          <h2>DNS for {dns.hostname}</h2>
          <table className="data-table">
            <tbody>
              <tr>
                <th>Ownership TXT</th>
                <td>
                  <span
                    className={`badge ${dns.report.verification.found ? 'badge-ok' : 'badge-warn'}`}
                  >
                    {dns.report.verification.found ? 'Found' : 'Missing'}
                  </span>{' '}
                  Add a TXT record on <code>{dns.report.verification.name}</code> with value{' '}
                  <code>{dns.report.verification.value}</code>
                </td>
              </tr>
              <tr>
                <th>MX</th>
                <td>
                  <span
                    className={`badge ${dns.report.mxOnCloudflare ? 'badge-ok' : 'badge-warn'}`}
                  >
                    {dns.report.mxOnCloudflare ? 'Cloudflare Email Routing' : 'Not Cloudflare'}
                  </span>{' '}
                  {dns.report.mx
                    .map((record) => `${record.priority} ${record.exchange}`)
                    .join(', ') || 'No MX records'}
                </td>
              </tr>
              <tr>
                <th>SPF</th>
                <td>
                  <span
                    className={`badge ${dns.report.spfIncludesCloudflare ? 'badge-ok' : 'badge-warn'}`}
                  >
                    {dns.report.spfIncludesCloudflare ? 'Includes Cloudflare' : 'Check'}
                  </span>{' '}
                  <code>{dns.report.spf ?? 'No SPF record'}</code>
                </td>
              </tr>
              <tr>
                <th>DMARC</th>
                <td>
                  <span className={`badge ${dns.report.dmarc ? 'badge-ok' : 'badge-warn'}`}>
                    {dns.report.dmarc ? 'Present' : 'Missing'}
                  </span>{' '}
                  <code>
                    {dns.report.dmarc ?? 'Add _dmarc TXT, for example v=DMARC1; p=quarantine'}
                  </code>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted">
            Enabling Email Routing and onboarding the domain for Email Sending in Cloudflare adds
            the MX, SPF and DKIM records for you.
          </p>
        </section>
      ) : null}
    </>
  );
}
