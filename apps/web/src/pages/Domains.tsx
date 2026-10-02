import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  applyDomainRecords,
  connectCloudflare,
  createDomain,
  type DirectoryDomain,
  type DomainSetup,
  deleteDomain,
  getDomainSetup,
  listDomains,
  setPrimaryDomain,
  verifyDomain,
  verifyDomainWithCloudflare,
} from '../api.js';

const badge = (status: string) =>
  status === 'ok' || status === 'verified'
    ? 'badge-ok'
    : status === 'different'
      ? 'badge-warn'
      : 'badge-off';

export function DomainsPage() {
  const [domains, setDomains] = useState<DirectoryDomain[]>([]);
  const [hostname, setHostname] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [setup, setSetup] = useState<DomainSetup | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => setDomains(await listDomains()), []);
  const loadSetup = useCallback(async (id: string) => {
    setSetup(null);
    setSetup(await getDomainSetup(id));
  }, []);

  useEffect(() => {
    void reload().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [reload]);

  useEffect(() => {
    if (selected) void loadSetup(selected).catch((err: unknown) => setError(String(err)));
  }, [selected, loadSetup]);

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

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await createDomain(hostname.trim());
      setHostname('');
      await reload();
      const created = (await listDomains()).find(
        (d) => d.hostname === hostname.trim().toLowerCase(),
      );
      if (created) setSelected(created.id);
    });
  };

  const cloudflareProvider = setup?.provider.id === 'cloudflare';

  return (
    <>
      <div className="page-header">
        <h1>Domains</h1>
        <p>Add a domain, prove you own it, then set up the DNS records mail needs.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <section className="panel">
        <h2>Add domain</h2>
        <form className="form-grid" onSubmit={onCreate}>
          <div className="field">
            <label htmlFor="hostname">Domain</label>
            <input
              id="hostname"
              placeholder="example.com"
              required
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </div>
          <div className="field field-action">
            <button className="btn" type="submit" disabled={busy}>
              Add domain
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Your domains</h2>
        <table className="data-table">
          <tbody>
            {domains.map((domain) => (
              <tr key={domain.id}>
                <td>
                  {domain.hostname}
                  {domain.primary ? ' (primary)' : ''}
                </td>
                <td>
                  <span className={`badge ${badge(domain.status)}`}>{domain.status}</span>
                </td>
                <td className="btn-row">
                  <button className="btn" type="button" onClick={() => setSelected(domain.id)}>
                    {domain.status === 'verified' ? 'DNS records' : 'Verify'}
                  </button>
                  {!domain.primary ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() =>
                        void run(async () => {
                          await setPrimaryDomain(domain.id);
                          await reload();
                        })
                      }
                    >
                      Make primary
                    </button>
                  ) : null}
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      if (!window.confirm(`Remove ${domain.hostname}?`)) return;
                      void run(async () => {
                        await deleteDomain(domain.id);
                        if (selected === domain.id) setSelected(null);
                        await reload();
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

      {selected && !setup ? <p>Checking DNS…</p> : null}
      {setup ? (
        <section className="panel">
          <h2>{setup.domain.hostname}</h2>
          <p>
            DNS is hosted at <strong>{setup.provider.name}</strong>
            {setup.provider.nameservers.length ? ` (${setup.provider.nameservers.join(', ')})` : ''}
            .
          </p>

          {cloudflareProvider && !setup.cloudflare.connected ? (
            <div className="panel">
              <h3>Connect Cloudflare (optional)</h3>
              <p className="muted">
                Let ASPECTenant add the DNS records for you. In Cloudflare create an API token with
                Zone: Read, DNS: Edit and Email Routing Rules: Edit for this zone. It is stored
                encrypted and is also used for mail app certificates.
              </p>
              <form
                className="form-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const result = await connectCloudflare(token);
                    setToken('');
                    setNotice(`Connected. Zones: ${result.zones.join(', ') || 'none visible'}`);
                    await loadSetup(setup.domain.id);
                  });
                }}
              >
                <div className="field">
                  <label htmlFor="cf-token">API token</label>
                  <input
                    id="cf-token"
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </div>
                <div className="field field-action">
                  <button className="btn" type="submit" disabled={busy || !token}>
                    Connect
                  </button>
                </div>
              </form>
            </div>
          ) : null}

          <h3>Step 1: Verify ownership</h3>
          {setup.domain.status === 'verified' ? (
            <p>
              <span className="badge badge-ok">Verified</span>
            </p>
          ) : (
            <>
              {setup.cloudflare.zone ? (
                <div className="btn-row">
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await verifyDomainWithCloudflare(setup.domain.id);
                        await reload();
                        await loadSetup(setup.domain.id);
                        setNotice('Verified through Cloudflare.');
                      })
                    }
                  >
                    Verify automatically with Cloudflare
                  </button>
                </div>
              ) : null}
              <p>Or add this TXT record at {setup.provider.name}, then select Verify:</p>
              <table className="data-table">
                <tbody>
                  <tr>
                    <th>Type</th>
                    <td>TXT</td>
                  </tr>
                  <tr>
                    <th>Name</th>
                    <td>
                      <code>@</code> ({setup.verification.name})
                    </td>
                  </tr>
                  <tr>
                    <th>Value</th>
                    <td>
                      <code>{setup.verification.value}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="btn-row">
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await verifyDomain(setup.domain.id);
                      await reload();
                      await loadSetup(setup.domain.id);
                      setNotice('Verified.');
                    })
                  }
                >
                  Verify
                </button>
              </div>
            </>
          )}

          {setup.domain.status === 'verified' ? (
            <>
              <h3>Step 2: Mail DNS records</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {setup.records.map((record) => (
                    <tr key={record.key}>
                      <td>
                        <span className={`badge ${badge(record.status)}`}>{record.status}</span>
                      </td>
                      <td>{record.type}</td>
                      <td>
                        <code>{record.name}</code>
                      </td>
                      <td>
                        <code>
                          {record.priority !== undefined ? `${record.priority} ` : ''}
                          {record.content}
                        </code>
                        {record.status === 'different' ? (
                          <div className="muted">Now: {record.found.join(', ')}</div>
                        ) : null}
                      </td>
                      <td className="muted">{record.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="btn-row">
                {setup.cloudflare.zone ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || setup.records.every((r) => r.status === 'ok')}
                    onClick={() =>
                      void run(async () => {
                        const result = await applyDomainRecords(setup.domain.id);
                        setNotice(
                          `Added: ${result.created.join(', ') || 'nothing'}${result.skipped.length ? `. Kept existing: ${result.skipped.join(', ')}` : ''}`,
                        );
                        await loadSetup(setup.domain.id);
                      })
                    }
                  >
                    Add missing records with Cloudflare
                  </button>
                ) : null}
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => loadSetup(setup.domain.id))}
                >
                  Check again
                </button>
              </div>
              <ul>
                {setup.manualSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
