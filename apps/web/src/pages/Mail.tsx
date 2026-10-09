import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addMailboxAlias,
  addMailboxMember,
  createMailbox,
  type DirectoryMailbox,
  type DirectoryUser,
  deleteMailbox,
  listMailboxes,
  listMailboxMembers,
  listUsers,
  removeMailboxAlias,
  removeMailboxMember,
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
  const [members, setMembers] = useState<
    Array<{ userId: string; email: string | null; displayName: string | null }>
  >([]);
  const [memberId, setMemberId] = useState('');

  useEffect(() => {
    if (!selectedId) return;
    void listMailboxMembers(selectedId)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [selectedId]);

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
          Create user and shared mailboxes, aliases and delegates. Messages are stored in
          ASPECTenant. Configure Cloudflare or SMTP under{' '}
          <Link to="/mail/settings">Mail settings</Link>.
        </p>
      </div>
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
                    Manage
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete ${mailbox.primaryAddress} and every message in it? This cannot be undone.`,
                        )
                      ) {
                        return;
                      }
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
          <h2>{selected.primaryAddress}</h2>
          <h3>Mailbox access</h3>
          <p className="muted">
            {selected.kind === 'user'
              ? 'The linked user always has access. Add delegates who can also read and send.'
              : 'People listed here can read and send from this shared mailbox.'}
          </p>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              if (!memberId) return;
              void addMailboxMember(selected.id, memberId)
                .then(() => listMailboxMembers(selected.id))
                .then(setMembers)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : 'Could not add access.');
                });
            }}
          >
            <div className="field">
              <label htmlFor="member">Person</label>
              <select id="member" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">Select a user</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Grant access
              </button>
            </div>
          </form>
          <ul>
            {members.map((member) => (
              <li key={member.userId}>
                {member.email ?? member.userId}{' '}
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    void removeMailboxMember(selected.id, member.userId)
                      .then(() => listMailboxMembers(selected.id))
                      .then(setMembers)
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
          <h3>Aliases</h3>
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
