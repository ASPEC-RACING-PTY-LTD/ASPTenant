import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  getMailSettings,
  type MailSettings,
  rotateIngestToken,
  saveMailSettings,
  testMailSettings,
} from '../api.js';

export function MailSettingsPage() {
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [kind, setKind] = useState<'none' | 'cloudflare' | 'smtp'>('none');
  const [cfToken, setCfToken] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [security, setSecurity] = useState<'tls' | 'starttls' | 'none'>('starttls');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: MailSettings) => {
    setSettings(next);
    setKind(next.outbound.kind);
    setHost(next.outbound.smtp.host);
    setPort(next.outbound.smtp.port);
    setSecurity(next.outbound.smtp.security);
    setUsername(next.outbound.smtp.username ?? '');
  }, []);

  useEffect(() => {
    void getMailSettings()
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
      const next = await saveMailSettings({
        kind,
        ...(cfToken.trim() ? { cloudflareToken: cfToken.trim() } : {}),
        smtp: {
          host,
          port,
          security,
          username: username.trim() || null,
          ...(password ? { password } : {}),
        },
      });
      apply(next);
      setCfToken('');
      setPassword('');
      setNotice('Saved. Use Test connection to confirm it works.');
    });
  };

  if (!settings) {
    return error ? <p className="notice notice-error">{error}</p> : <p>Loading…</p>;
  }

  return (
    <>
      <div className="page-header">
        <h1>Mail settings</h1>
        <p>
          Mailboxes and messages live in ASPECTenant. Cloudflare (or any SMTP relay) only carries
          mail in and out.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}

      <section className="panel">
        <h2>Outbound sending</h2>
        <form className="form-grid" onSubmit={onSave}>
          <div className="field">
            <label htmlFor="kind">Transport</label>
            <select
              id="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="none">Not configured</option>
              <option value="cloudflare">Cloudflare Email Sending</option>
              <option value="smtp">SMTP server or relay</option>
            </select>
          </div>
          {kind === 'cloudflare' ? (
            <div className="field">
              <label htmlFor="cf-token">
                Cloudflare API token {settings.outbound.cloudflare.hasToken ? '(saved)' : ''}
              </label>
              <input
                id="cf-token"
                type="password"
                autoComplete="off"
                placeholder={
                  settings.outbound.cloudflare.hasToken ? 'Leave blank to keep' : 'Token value'
                }
                value={cfToken}
                onChange={(event) => setCfToken(event.target.value)}
              />
              <small className="muted">
                Token permission: Email Sending: Edit. Your domain must be onboarded under Email
                Sending in Cloudflare. Limits: 5 MiB per message, 50 recipients, Workers Paid plan
                to send to any address.
              </small>
            </div>
          ) : null}
          {kind === 'smtp' ? (
            <>
              <div className="field">
                <label htmlFor="host">Host</label>
                <input id="host" value={host} onChange={(event) => setHost(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="port">Port</label>
                <input
                  id="port"
                  type="number"
                  value={port}
                  onChange={(event) => setPort(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="security">Security</label>
                <select
                  id="security"
                  value={security}
                  onChange={(event) => setSecurity(event.target.value as typeof security)}
                >
                  <option value="starttls">STARTTLS (usually 587)</option>
                  <option value="tls">TLS (usually 465)</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="username">Username</label>
                <input
                  id="username"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="password">
                  Password {settings.outbound.smtp.hasPassword ? '(saved)' : ''}
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.outbound.smtp.hasPassword ? 'Leave blank to keep' : ''}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </>
          ) : null}
          <div className="field field-action">
            <button className="btn" type="submit" disabled={busy}>
              Save
            </button>
          </div>
        </form>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              setNotice((await testMailSettings(testTo.trim() || undefined)).detail);
            });
          }}
        >
          <div className="field">
            <label htmlFor="test-to">Send a test message to (optional)</label>
            <input
              id="test-to"
              type="email"
              placeholder="you@gmail.com"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
            />
          </div>
          <div className="field field-action">
            <button className="btn btn-ghost" type="submit" disabled={busy}>
              Test connection
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Inbound with Cloudflare Email Routing</h2>
        <p>
          Status:{' '}
          {settings.ingest.configured ? (
            <span className="badge badge-ok">Ingest token set</span>
          ) : (
            <span className="badge badge-warn">Not set up</span>
          )}
        </p>
        <ol className="steps">
          <li>
            In Cloudflare, open your domain, go to <strong>Email &gt; Email Routing</strong> and
            enable it. Cloudflare adds the MX and SPF records.
          </li>
          <li>
            Generate an ingest token below and copy it. It is shown once.
            <div className="btn-row">
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      settings.ingest.configured &&
                      !window.confirm('Replace the current token? The Worker must be updated too.')
                    ) {
                      return;
                    }
                    setToken(await rotateIngestToken());
                    setSettings({ ...settings, ingest: { ...settings.ingest, configured: true } });
                  })
                }
              >
                {settings.ingest.configured ? 'Replace ingest token' : 'Generate ingest token'}
              </button>
            </div>
            {token ? <pre className="code">{token}</pre> : null}
          </li>
          <li>
            Create a Worker (<strong>Workers &amp; Pages &gt; Create &gt; Hello World</strong>),
            choose <strong>Edit code</strong>, replace everything with the script below and deploy.
          </li>
          <li>
            In the Worker, open <strong>Settings &gt; Variables and Secrets</strong> and add a
            secret named <code>INGEST_TOKEN</code> with the token.
          </li>
          <li>
            Back in Email Routing, open <strong>Routing rules</strong>, edit the{' '}
            <strong>Catch-all address</strong>, set the action to <strong>Send to a Worker</strong>{' '}
            and pick your Worker. Enable it.
          </li>
          <li>
            If Cloudflare Access protects this hostname, add a bypass for{' '}
            <code>/api/v1/mail/ingest</code>. The Worker calls <code>{settings.ingest.url}</code>.
          </li>
        </ol>
        <div className="btn-row">
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => void navigator.clipboard.writeText(settings.workerScript)}
          >
            Copy Worker script
          </button>
        </div>
        <pre className="code">{settings.workerScript}</pre>
      </section>
    </>
  );
}
