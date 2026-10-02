import { type FormEvent, useEffect, useState } from 'react';
import {
  addMailboxAlias,
  createMailbox,
  type DirectoryMailbox,
  type DirectoryUser,
  deleteMailbox,
  listMailboxes,
  listUsers,
  removeMailboxAlias,
} from '../api.js';

export function MailPage() {
  const [mailboxes, setMailboxes] = useState<DirectoryMailbox[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<'shared' | 'user'>('shared');
  const [userId, setUserId] = useState('');
  const [alias, setAlias] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = async () => {
    const [nextMailboxes, nextUsers] = await Promise.all([listMailboxes(), listUsers()]);
    setMailboxes(nextMailboxes);
    setUsers(nextUsers);
  };

  useEffect(() => {
    void Promise.all([listMailboxes(), listUsers()])
      .then(([nextMailboxes, nextUsers]) => {
        setMailboxes(nextMailboxes);
        setUsers(nextUsers);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load mailboxes.');
      });
  }, []);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await createMailbox({
        kind,
        primaryAddress: address,
        ...(kind === 'user' && userId ? { userId } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setAddress('');
      setDisplayName('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the mailbox.');
    }
  };

  const selected = mailboxes.find((item) => item.id === selectedId) ?? null;

  return (
    <>
      <div className="page-header">
        <h1>Mail</h1>
        <p>
          ASPECTenant owns mailbox data. This page administers directory records and aliases only.
          Cloudflare or another relay is transport, not the mailbox.
        </p>
      </div>
      <p className="notice">
        No message store, ingest, IMAP, outbound submission or webmail is running. Addresses can be
        reserved here so later mail services have a directory to attach to.
      </p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Provision mailbox</h2>
        <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
          <div className="field">
            <label htmlFor="mb-kind">Kind</label>
            <select
              id="mb-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'shared' | 'user')}
            >
              <option value="shared">Shared</option>
              <option value="user">User</option>
            </select>
          </div>
          {kind === 'user' ? (
            <div className="field">
              <label htmlFor="mb-user">User</label>
              <select id="mb-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Select a user</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="mb-address">Primary address</label>
            <input
              id="mb-address"
              type="email"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="mb-name">Display name</label>
            <input
              id="mb-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="field field-action">
            <button className="btn" type="submit">
              Provision
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Mailbox directory</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Address</th>
              <th>Kind</th>
              <th>Aliases</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((mailbox) => (
              <tr key={mailbox.id}>
                <td>{mailbox.primaryAddress}</td>
                <td>{mailbox.kind}</td>
                <td>{mailbox.aliases.join(', ') || 'none'}</td>
                <td className="btn-row">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setSelectedId(mailbox.id)}
                  >
                    Aliases
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      void deleteMailbox(mailbox.id)
                        .then(() => {
                          if (selectedId === mailbox.id) setSelectedId(null);
                          return reload();
                        })
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Delete failed.');
                        });
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {selected ? (
        <section className="panel">
          <h2>Aliases for {selected.primaryAddress}</h2>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void addMailboxAlias(selected.id, alias)
                .then(() => {
                  setAlias('');
                  return reload();
                })
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : 'Alias failed.');
                });
            }}
          >
            <div className="field">
              <label htmlFor="alias">Alias</label>
              <input
                id="alias"
                type="email"
                required
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
              />
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Add alias
              </button>
            </div>
          </form>
          <ul>
            {selected.aliases.map((item) => (
              <li key={item}>
                {item}{' '}
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    void removeMailboxAlias(selected.id, item)
                      .then(reload)
                      .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : 'Remove failed.');
                      });
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
