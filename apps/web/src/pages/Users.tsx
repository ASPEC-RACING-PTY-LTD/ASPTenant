import { type FormEvent, useEffect, useState } from 'react';
import {
  createUser,
  type DirectoryUser,
  listUsers,
  reinstateUser,
  removeUser,
  setUserRole,
  suspendUser,
  type TenantRole,
  updateUser,
} from '../api.js';
import { useAuth } from '../auth.js';

type RoleChoice = 'member' | TenantRole;

function roleOf(user: DirectoryUser): string {
  if (user.orgRole === 'owner' || user.roles.includes('tenant.owner')) return 'Owner';
  if (user.roles.includes('tenant.admin')) return 'Administrator';
  if (user.roles.includes('tenant.auditor')) return 'Auditor';
  return 'Member';
}

function choiceOf(user: DirectoryUser): RoleChoice {
  if (user.roles.includes('tenant.admin')) return 'tenant.admin';
  if (user.roles.includes('tenant.auditor')) return 'tenant.auditor';
  return 'member';
}

export function UsersPage() {
  const { session } = useAuth();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<RoleChoice>('member');
  const [notice, setNotice] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<RoleChoice>('member');
  const canManageMembers = session?.permissions.includes('orgs.members:manage') === true;
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
    setNotice(null);
    try {
      const result = await createUser({
        email,
        password,
        role: role === 'member' ? null : role,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setNotice(
        result.mailboxId
          ? `${email} was created with a mailbox record.`
          : `${email} was created. No mailbox record was made because the address is not on a verified domain of this organisation.`,
      );
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
        <p>
          People in this organisation. A mailbox record is created for users whose address is on a
          verified domain.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
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
            <label htmlFor="user-role">Role in this organisation</label>
            <select
              id="user-role"
              value={role}
              onChange={(e) => setRole(e.target.value as RoleChoice)}
            >
              <option value="member">Member</option>
              <option value="tenant.admin">Administrator</option>
              <option value="tenant.auditor">Auditor</option>
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
                  <td>{roleOf(user)}</td>
                  <td>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        setSelected(user);
                        setEditName(user.displayName ?? '');
                        setEditRole(choiceOf(user));
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
            Role: {roleOf(selected)}. Mailbox: {selected.mailboxId ? 'provisioned' : 'none'}.
          </p>
          {canManageMembers && selected.id !== session?.user.id && roleOf(selected) !== 'Owner' ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="edit-role">Role in this organisation</label>
                <select
                  id="edit-role"
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as RoleChoice)}
                >
                  <option value="member">Member</option>
                  <option value="tenant.admin">Administrator</option>
                  <option value="tenant.auditor">Auditor</option>
                </select>
              </div>
              <div className="field field-action">
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void setUserRole(selected.id, editRole === 'member' ? null : editRole)
                      .then(reload)
                      .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : 'Role update failed.');
                      });
                  }}
                >
                  Save role
                </button>
              </div>
            </div>
          ) : null}
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
          {canManageMembers && selected.id !== session?.user.id ? (
            <div className="btn-row">
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => {
                  void removeUser(selected.id)
                    .then(() => {
                      setSelected(null);
                      return reload();
                    })
                    .catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : 'Remove failed.');
                    });
                }}
              >
                Remove from organisation
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
