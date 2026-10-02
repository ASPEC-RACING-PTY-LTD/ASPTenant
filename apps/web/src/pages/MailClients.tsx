import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  getMailClients,
  issueMailCertificate,
  type MailClientSettings,
  saveMailClients,
} from '../api.js';

export function MailClientsPage() {
  const [settings, setSettings] = useState<MailClientSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hostname, setHostname] = useState('');
  const [certMode, setCertMode] = useState<'acme' | 'manual'>('acme');
  const [acmeEmail, setAcmeEmail] = useState('');
  const [dnsToken, setDnsToken] = useState('');
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: MailClientSettings) => {
    setSettings(next);
    setEnabled(next.enabled);
    setHostname(next.hostname);
    setCertMode(next.certMode);
    setAcmeEmail(next.acmeEmail ?? '');
  }, []);

  useEffect(() => {
    void getMailClients()
      .then(apply)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [apply]);

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

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      apply(
        await saveMailClients({
          enabled,
          hostname,
          certMode,
          acmeEmail: acmeEmail.trim() || null,
          ...(dnsToken.trim() ? { cloudflareDnsToken: dnsToken.trim() } : {}),
          ...(certMode === 'manual' && certPem.trim() ? { certPem, keyPem } : {}),
        }),
      );
      setDnsToken('');
      setKeyPem('');
      setNotice('Saved.');
    });
  };

  if (!settings) return error ? <p className="notice notice-error">{error}</p> : <p>Loading…</p>;

  return (
    <>
      <div className="page-header">
        <h1>Mail apps</h1>
        <p>
          IMAP and SMTP for Outlook, Apple Mail, Thunderbird and phones. Outgoing mail from apps is
          sent through the transport on Mail settings (for example Cloudflare).
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
          {settings.running ? (
            <span className="badge badge-ok">Running</span>
          ) : (
            <span className="badge badge-off">Stopped</span>
          )}{' '}
          {settings.certExpiresAt
            ? `Certificate valid until ${new Date(settings.certExpiresAt).toLocaleDateString()}`
            : 'No certificate yet'}
        </p>
        {settings.lastError ? <p className="notice notice-error">{settings.lastError}</p> : null}
        <table className="data-table">
          <tbody>
            <tr>
              <th>Incoming (IMAP)</th>
              <td>
                {settings.hostname || 'mail.example.com'}, port {settings.ports.imaps}, SSL/TLS
              </td>
            </tr>
            <tr>
              <th>Outgoing (SMTP)</th>
              <td>
                {settings.hostname || 'mail.example.com'}, port {settings.ports.smtps} SSL/TLS, or{' '}
                {settings.ports.submission} STARTTLS
              </td>
            </tr>
            <tr>
              <th>Username / password</th>
              <td>Your ASPECTenant sign-in email and password</td>
            </tr>
            <tr>
              <th>Shared mailboxes</th>
              <td>Appear under Shared/&lt;address&gt; in the folder list</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Mail apps connect directly, not through Cloudflare Tunnel. Forward TCP ports 993, 465 and
          587 to this server and add a DNS-only (grey cloud) A record for the hostname.
        </p>
      </section>
      <section className="panel">
        <h2>Settings</h2>
        <form className="form-grid" onSubmit={onSave}>
          <div className="field">
            <label className="toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />{' '}
              Enable IMAP and SMTP
            </label>
          </div>
          <div className="field">
            <label htmlFor="mc-host">Hostname</label>
            <input
              id="mc-host"
              placeholder="mail.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="mc-mode">Certificate</label>
            <select
              id="mc-mode"
              value={certMode}
              onChange={(event) => setCertMode(event.target.value as 'acme' | 'manual')}
            >
              <option value="acme">Let's Encrypt via Cloudflare DNS</option>
              <option value="manual">Upload my own</option>
            </select>
          </div>
          {certMode === 'acme' ? (
            <>
              <div className="field">
                <label htmlFor="mc-token">
                  Cloudflare API token {settings.hasDnsToken ? '(saved)' : ''}
                </label>
                <input
                  id="mc-token"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    settings.hasDnsToken ? 'Leave blank to keep' : 'Zone:Read and DNS:Edit'
                  }
                  value={dnsToken}
                  onChange={(event) => setDnsToken(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="mc-email">Expiry notices email (optional)</label>
                <input
                  id="mc-email"
                  type="email"
                  value={acmeEmail}
                  onChange={(event) => setAcmeEmail(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="mc-cert">Certificate chain (PEM)</label>
                <textarea
                  id="mc-cert"
                  rows={4}
                  value={certPem}
                  onChange={(e) => setCertPem(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="mc-key">Private key (PEM)</label>
                <textarea
                  id="mc-key"
                  rows={4}
                  value={keyPem}
                  onChange={(e) => setKeyPem(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="field field-action">
            <button className="btn" type="submit" disabled={busy}>
              Save
            </button>
          </div>
        </form>
        {certMode === 'acme' ? (
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              type="button"
              disabled={busy || !settings.hostname || !settings.hasDnsToken}
              onClick={() =>
                void run(async () => {
                  setNotice('Requesting a certificate. This takes about a minute.');
                  apply(await issueMailCertificate());
                  setNotice('Certificate issued. It renews automatically.');
                })
              }
            >
              {busy
                ? 'Working…'
                : settings.hasCertificate
                  ? 'Renew certificate now'
                  : 'Get certificate'}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
