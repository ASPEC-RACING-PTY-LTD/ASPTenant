import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  createCredential,
  type DirectoryMailbox,
  deleteCredential,
  getMailClients,
  listCredentials,
  listMailboxes,
  type MailboxGrant,
  type MailClientSettings,
  rotateCredential,
  type ServiceCredential,
  updateCredential,
} from '../api.js';
import { useAuth } from '../auth.js';

type Access = Omit<MailboxGrant, 'mailboxId'>;
const NO_ACCESS: Access = { read: false, write: false, send: false };

/** Shown once after a credential is created or its password replaced. */
interface Revealed {
  username: string;
  password: string;
}

function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function when(value: number | null): string {
  return value ? new Date(value).toLocaleString() : 'Never';
}

function accessLabel(grant: MailboxGrant): string {
  const parts = [];
  if (grant.write) parts.push('read and change');
  else if (grant.read) parts.push('read');
  if (grant.send) parts.push('send');
  return parts.join(', ');
}

export function CredentialsPage() {
  const { session } = useAuth();
  const canManage = session?.permissions.includes('mail:manage') ?? false;
  const [items, setItems] = useState<ServiceCredential[]>([]);
  const [mailboxes, setMailboxes] = useState<DirectoryMailbox[]>([]);
  const [server, setServer] = useState<MailClientSettings | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Application credential form (also used to edit one).
  const [editing, setEditing] = useState<ServiceCredential | null>(null);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [ips, setIps] = useState('');
  const [expires, setExpires] = useState('');
  const [password, setPassword] = useState('');

  // Shared mailbox login form.
  const [sharedId, setSharedId] = useState('');
  const [sharedIps, setSharedIps] = useState('');
  const [sharedPassword, setSharedPassword] = useState('');

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const reload = useCallback(async () => {
    setItems(await listCredentials());
  }, []);

  useEffect(() => {
    void Promise.all([listCredentials(), listMailboxes()])
      .then(([credentials, boxes]) => {
        setItems(credentials);
        setMailboxes(boxes);
      })
      .catch(fail);
    void getMailClients()
      .then(setServer)
      .catch(() => undefined);
  }, [fail]);

  const address = (id: string) => mailboxes.find((item) => item.id === id)?.primaryAddress ?? id;
  const sharedWithoutLogin = mailboxes.filter(
    (mailbox) =>
      mailbox.kind === 'shared' &&
      !items.some((item) => item.kind === 'mailbox' && item.username === mailbox.primaryAddress),
  );

  const resetForm = () => {
    setEditing(null);
    setName('');
    setAccess({});
    setIps('');
    setExpires('');
    setPassword('');
  };

  const setGrant = (mailboxId: string, key: keyof Access, value: boolean) => {
    setAccess((current) => {
      const next = { ...(current[mailboxId] ?? NO_ACCESS), [key]: value };
      // Changing a mailbox needs reading it; no reading means no changing.
      if (key === 'write' && value) next.read = true;
      if (key === 'read' && !value) next.write = false;
      return { ...current, [mailboxId]: next };
    });
  };

  const grants = (): MailboxGrant[] =>
    Object.entries(access)
      .filter(([, item]) => item.read || item.write || item.send)
      .map(([mailboxId, item]) => ({ mailboxId, ...item }));

  const onSaveService = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setRevealed(null);
    try {
      const expiresAt = expires ? new Date(`${expires}T23:59:59`).getTime() : null;
      if (editing) {
        await updateCredential(editing.id, {
          name: name.trim(),
          grants: grants(),
          allowedIps: splitList(ips),
          expiresAt,
        });
        setNotice(`${name.trim() || editing.username} was saved.`);
      } else {
        const created = await createCredential({
          kind: 'service',
          ...(name.trim() ? { name: name.trim() } : {}),
          grants: grants(),
          allowedIps: splitList(ips),
          expiresAt,
          ...(password ? { password } : {}),
        });
        setRevealed({ username: created.credential.username, password: created.password });
      }
      resetForm();
      await reload();
    } catch (err) {
      fail(err);
    }
  };

  const onCreateShared = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setRevealed(null);
    try {
      const created = await createCredential({
        kind: 'mailbox',
        mailboxId: sharedId,
        allowedIps: splitList(sharedIps),
        ...(sharedPassword ? { password: sharedPassword } : {}),
      });
      setRevealed({ username: created.credential.username, password: created.password });
      setSharedId('');
      setSharedIps('');
      setSharedPassword('');
      await reload();
    } catch (err) {
      fail(err);
    }
  };

  const edit = (item: ServiceCredential) => {
    setEditing(item);
    setName(item.name);
    setAccess(
      Object.fromEntries(
        item.grants.map((grant) => [
          grant.mailboxId,
          { read: grant.read, write: grant.write, send: grant.send },
        ]),
      ),
    );
    setIps(item.allowedIps.join('\n'));
    setExpires(item.expiresAt ? new Date(item.expiresAt).toISOString().slice(0, 10) : '');
    setPassword('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const run = (task: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    void task().then(reload).catch(fail);
  };

  const hostname = server?.hostname || 'your mail hostname';

  return (
    <>
      <div className="page-header">
        <h1>Service credentials</h1>
        <p>
          Logins for applications and shared mailboxes to use IMAP and SMTP. Each credential reaches
          only the mailboxes you give it, with the access you choose, and can be limited to specific
          IP addresses. Passwords are shown once.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {revealed ? (
        <section className="panel">
          <h2>Save this password now</h2>
          <p>It cannot be shown again. Replace it from the list below if it is lost.</p>
          <table className="data-table">
            <tbody>
              <tr>
                <th>Username</th>
                <td>
                  <code>{revealed.username}</code>
                </td>
              </tr>
              <tr>
                <th>Password</th>
                <td>
                  <code>{revealed.password}</code>{' '}
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(revealed.password)}
                  >
                    Copy
                  </button>
                </td>
              </tr>
              <tr>
                <th>SMTP</th>
                <td>
                  {hostname}, port {server?.ports.submission ?? 587} (STARTTLS) or{' '}
                  {server?.ports.smtps ?? 465} (SSL/TLS)
                </td>
              </tr>
              <tr>
                <th>IMAP</th>
                <td>
                  {hostname}, port {server?.ports.imaps ?? 993} (SSL/TLS)
                </td>
              </tr>
            </tbody>
          </table>
          <div className="btn-row">
            <button className="btn btn-ghost" type="button" onClick={() => setRevealed(null)}>
              I have saved it
            </button>
          </div>
        </section>
      ) : null}
      {server && !server.running ? (
        <p className="notice">
          IMAP and SMTP are not running on this installation yet. Credentials work once a platform
          operator turns them on under Mail apps.
        </p>
      ) : null}
      {canManage ? (
        <section className="panel">
          <h2>{editing ? `Edit ${editing.name}` : 'Application credential'}</h2>
          <p className="muted">
            For apps, printers, CRMs and scripts. The username is generated. Read lets it fetch mail
            over IMAP, change lets it flag, move and delete, and send lets it send over SMTP from
            the mailbox address and its aliases.
          </p>
          <form onSubmit={(event) => void onSaveService(event)}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cred-name">Name</label>
                <input
                  id="cred-name"
                  placeholder="for example Website contact form"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="cred-expires">Expires (optional)</label>
                <input
                  id="cred-expires"
                  type="date"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </div>
              {editing ? null : (
                <div className="field">
                  <label htmlFor="cred-password">Password (optional)</label>
                  <input
                    id="cred-password"
                    type="password"
                    minLength={12}
                    placeholder="generated when empty"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              )}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Read</th>
                  <th>Change</th>
                  <th>Send</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => {
                  const current = access[mailbox.id] ?? NO_ACCESS;
                  return (
                    <tr key={mailbox.id}>
                      <td>
                        {mailbox.primaryAddress}
                        {mailbox.kind === 'shared' ? ' (shared)' : ''}
                      </td>
                      {(['read', 'write', 'send'] as const).map((key) => (
                        <td key={key}>
                          <input
                            type="checkbox"
                            aria-label={`${key} ${mailbox.primaryAddress}`}
                            checked={current[key]}
                            onChange={(e) => setGrant(mailbox.id, key, e.target.checked)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="cred-ips">Allowed IP addresses (optional)</label>
                <textarea
                  id="cred-ips"
                  rows={3}
                  placeholder={'203.0.113.10\n10.0.0.0/8\nempty allows any address'}
                  value={ips}
                  onChange={(e) => setIps(e.target.value)}
                />
              </div>
              <div className="field field-action">
                <div className="btn-row">
                  <button className="btn" type="submit" disabled={grants().length === 0}>
                    {editing ? 'Save credential' : 'Create credential'}
                  </button>
                  {editing ? (
                    <button className="btn btn-ghost" type="button" onClick={resetForm}>
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </form>
        </section>
      ) : null}
      {canManage ? (
        <section className="panel">
          <h2>Shared mailbox login</h2>
          <p className="muted">
            Lets a shared mailbox sign in to Outlook, a phone or any mail app with its own address
            and password, with full access to that mailbox only. Members still reach it through
            their own accounts.
          </p>
          {sharedWithoutLogin.length === 0 ? (
            <p className="muted">Every shared mailbox already has a login.</p>
          ) : (
            <form className="form-grid" onSubmit={(event) => void onCreateShared(event)}>
              <div className="field">
                <label htmlFor="shared-mailbox">Shared mailbox</label>
                <select
                  id="shared-mailbox"
                  required
                  value={sharedId}
                  onChange={(e) => setSharedId(e.target.value)}
                >
                  <option value="">Select a mailbox</option>
                  {sharedWithoutLogin.map((mailbox) => (
                    <option key={mailbox.id} value={mailbox.id}>
                      {mailbox.primaryAddress}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="shared-password">Password (optional)</label>
                <input
                  id="shared-password"
                  type="password"
                  minLength={12}
                  placeholder="generated when empty"
                  value={sharedPassword}
                  onChange={(e) => setSharedPassword(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="shared-ips">Allowed IP addresses (optional)</label>
                <input
                  id="shared-ips"
                  placeholder="empty allows any address"
                  value={sharedIps}
                  onChange={(e) => setSharedIps(e.target.value)}
                />
              </div>
              <div className="field field-action">
                <button className="btn" type="submit">
                  Create login
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}
      <section className="panel">
        <h2>Credentials</h2>
        {items.length === 0 ? (
          <p className="muted">No credentials yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Access</th>
                <th>Allowed IPs</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const expired = item.expiresAt !== null && item.expiresAt <= Date.now();
                return (
                  <tr key={item.id}>
                    <td>
                      {item.name}
                      <div className="muted">
                        {item.kind === 'mailbox' ? 'Shared mailbox login' : 'Application'}
                      </div>
                    </td>
                    <td>
                      <code>{item.username}</code>
                    </td>
                    <td>
                      {item.grants.map((grant) => (
                        <div key={grant.mailboxId}>
                          {address(grant.mailboxId)}: {accessLabel(grant)}
                        </div>
                      ))}
                    </td>
                    <td>{item.allowedIps.length ? item.allowedIps.join(', ') : 'Any'}</td>
                    <td>
                      {when(item.lastUsedAt)}
                      {item.lastUsedIp ? <div className="muted">{item.lastUsedIp}</div> : null}
                    </td>
                    <td>
                      <span
                        className={`badge ${item.enabled && !expired ? 'badge-ok' : 'badge-warn'}`}
                      >
                        {!item.enabled ? 'disabled' : expired ? 'expired' : 'active'}
                      </span>
                      {item.expiresAt && !expired ? (
                        <div className="muted">until {when(item.expiresAt)}</div>
                      ) : null}
                    </td>
                    <td className="btn-row">
                      {canManage ? (
                        <>
                          {item.kind === 'service' ? (
                            <button
                              className="btn btn-ghost"
                              type="button"
                              onClick={() => edit(item)}
                            >
                              Edit
                            </button>
                          ) : (
                            <button
                              className="btn btn-ghost"
                              type="button"
                              onClick={() => {
                                const next = window.prompt(
                                  'Allowed IP addresses, separated by commas. Leave empty to allow any address.',
                                  item.allowedIps.join(', '),
                                );
                                if (next === null) return;
                                run(() =>
                                  updateCredential(item.id, { allowedIps: splitList(next) }),
                                );
                              }}
                            >
                              IP addresses
                            </button>
                          )}
                          <button
                            className="btn btn-ghost"
                            type="button"
                            onClick={() =>
                              run(() => updateCredential(item.id, { enabled: !item.enabled }))
                            }
                          >
                            {item.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            className="btn btn-ghost"
                            type="button"
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Replace the password of ${item.username}? Apps using the old one stop working.`,
                                )
                              )
                                return;
                              setError(null);
                              void rotateCredential(item.id)
                                .then((secret) =>
                                  setRevealed({ username: item.username, password: secret }),
                                )
                                .catch(fail);
                            }}
                          >
                            New password
                          </button>
                          <button
                            className="btn btn-danger"
                            type="button"
                            onClick={() => {
                              if (!window.confirm(`Delete ${item.name}? It stops working at once.`))
                                return;
                              run(() => deleteCredential(item.id));
                            }}
                          >
                            Delete
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
