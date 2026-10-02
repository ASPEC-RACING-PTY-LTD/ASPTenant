import { type FormEvent, useEffect, useState } from 'react';
import {
  createUser,
  type DirectoryUser,
  listUsers,
  reinstateUser,
  suspendUser,
  updateUser,
} from '../api.js';
import { useAuth } from '../auth.js';

export function UsersPage() {
  const { session } = useAuth();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [orgRole, setOrgRole] = useState<'admin' | 'member'>('member');
  const [selected, setSelected] = useState<DirectoryUser | null>(null);
  const [editName, setEditName] = useState('');
  const [reason, setReason] = useState('Suspended by administrator');

  const reload = async () => {
    const items = await listUsers();
    setUsers(items);
    if (selected) {
      setSelected(items.find((item) => item.id === selected.id) ?? null);
    }
  };

  useEffect(() => {
    void listUsers()
      .then(setUsers)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load users.');
      });
  }, []);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createUser({
        email,
        password,
        orgRole,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setEmail('');
      setPassword('');
      setDisplayName('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the user.');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Users</h1>
        <p>Organisation directory. Creating a user also provisions a mailbox record.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Create user</h2>
        <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
          <div className="field">
            <label htmlFor="user-name">Display name</label>
            <input
              id="user-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="user-email">Email</label>
            <input
              id="user-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="user-password">Password</label>
            <input
              id="user-password"
              type="password"
              minLength={12}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="user-role">Organisation role</label>
            <select
              id="user-role"
              value={orgRole}
              onChange={(e) => setOrgRole(e.target.value as 'admin' | 'member')}
            >
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          <div className="field field-action">
            <button className="btn" type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Directory</h2>
        {users.length === 0 ? (
          <p>No users loaded.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.displayName ?? 'Unnamed'}</td>
                  <td>{user.email}</td>
                  <td>
                    <span
                      className={`badge ${user.status === 'active' ? 'badge-ok' : 'badge-warn'}`}
                    >
                      {user.status}
                    </span>
                  </td>
                  <td>{user.orgRole ?? 'none'}</td>
                  <td>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        setSelected(user);
                        setEditName(user.displayName ?? '');
                      }}
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {selected ? (
        <section className="panel">
          <h2>{selected.email}</h2>
          <p>
            Platform roles: {selected.platformRoles.join(', ') || 'none'}. Mailbox:{' '}
            {selected.mailboxId ? 'provisioned' : 'none'}.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="edit-name">Display name</label>
              <input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="field field-action">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  void updateUser(selected.id, editName.trim() || null)
                    .then(reload)
                    .catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : 'Update failed.');
                    });
                }}
              >
                Save name
              </button>
            </div>
          </div>
          {selected.id !== session?.user.id ? (
            selected.status === 'suspended' ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  void reinstateUser(selected.id)
                    .then(reload)
                    .catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : 'Reinstate failed.');
                    });
                }}
              >
                Reinstate
              </button>
            ) : (
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="suspend-reason">Suspend reason</label>
                  <input
                    id="suspend-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="field field-action">
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      void suspendUser(selected.id, reason)
                        .then(reload)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Suspend failed.');
                        });
                    }}
                  >
                    Suspend
                  </button>
                </div>
              </div>
            )
          ) : (
            <p>You cannot suspend your own account.</p>
          )}
        </section>
      ) : null}
    </>
  );
}
