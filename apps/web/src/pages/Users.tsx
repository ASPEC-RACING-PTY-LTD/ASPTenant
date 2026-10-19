import { type FormEvent, useEffect, useState } from 'react';
import {
  type AnyTenantRole,
  type AuthSession,
  createUser,
  type DirectoryUser,
  listUserSessions,
  listUsers,
  reinstateUser,
  removeUser,
  resetUserTwoStep,
  revokeUserSession,
  setUserPassword,
  setUserRole,
  suspendUser,
  type TenantRole,
  updateUser,
} from '../api.js';
import { useAuth } from '../auth.js';

type RoleChoice = 'member' | AnyTenantRole;

function isOwner(user: DirectoryUser): boolean {
  return user.orgRole === 'owner' || user.roles.includes('tenant.owner');
}

function roleOf(user: DirectoryUser): string {
  if (isOwner(user)) return 'Owner';
  if (user.roles.includes('tenant.admin')) return 'Administrator';
  if (user.roles.includes('tenant.auditor')) return 'Auditor';
  return 'Member';
}

function choiceOf(user: DirectoryUser): RoleChoice {
  if (isOwner(user)) return 'tenant.owner';
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
  const [role, setRole] = useState<'member' | TenantRole>('member');
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<DirectoryUser | null>(null);
  const [editRole, setEditRole] = useState<RoleChoice>('member');
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [reason, setReason] = useState('Suspended by administrator');
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);

  const permissions = session?.permissions ?? [];
  const canInvite = permissions.includes('users:invite');
  const canUpdate = permissions.includes('users:update');
  const canSuspend = permissions.includes('users:suspend');
  const canManageMembers = permissions.includes('orgs.members:manage');
  const canReadSecurity = permissions.includes('security:read');
  const canManageSecurity = permissions.includes('security:manage');
  const iAmOwner = session?.membership?.role === 'owner';

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

  /** Runs one change, then reloads the directory and reports the outcome. */
  const act = async (action: () => Promise<unknown>, done: string, failed: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      await reload();
      setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    }
  };

  const open = (user: DirectoryUser) => {
    setSelected(user);
    setEditName(user.displayName ?? '');
    setEditEmail(user.email);
    setEditRole(choiceOf(user));
    setNewPassword('');
    setSessions(null);
  };

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

  const self = selected?.id === session?.user.id;
  // Administrators manage everyone except owners. Owners manage everyone.
  const locked = selected ? isOwner(selected) && !iAmOwner && !self : false;
  // Sign-in details of people in other organisations are changed by a platform operator.
  const shared = Boolean(selected?.otherOrganisations) && !self;

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
      {canInvite ? (
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
            {canManageMembers ? (
              <div className="field">
                <label htmlFor="user-role">Role in this organisation</label>
                <select
                  id="user-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'member' | TenantRole)}
                >
                  <option value="member">Member</option>
                  <option value="tenant.admin">Administrator</option>
                  <option value="tenant.auditor">Auditor</option>
                </select>
              </div>
            ) : null}
            <div className="field field-action">
              <button className="btn" type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create user'}
              </button>
            </div>
          </form>
        </section>
      ) : null}
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
                    <button className="btn btn-ghost" type="button" onClick={() => open(user)}>
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
            Two-step verification: {selected.mfaEnabled ? 'on' : 'off'}.
          </p>
          {locked ? (
            <p className="notice">
              This person is an owner of the organisation. Only another owner can change them.
            </p>
          ) : null}
          {shared ? (
            <p className="muted">
              This account also belongs to another organisation, so its name, email, password,
              two-step verification and sessions are changed by a platform operator. Role,
              suspension and removal here affect this organisation only.
            </p>
          ) : null}

          {canUpdate && !locked && !shared ? (
            <>
              <h3>Profile</h3>
              <form
                className="form-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  const patch: { displayName?: string | null; email?: string } = {};
                  if (editName.trim() !== (selected.displayName ?? '')) {
                    patch.displayName = editName.trim() || null;
                  }
                  if (editEmail.trim().toLowerCase() !== selected.email) {
                    patch.email = editEmail.trim();
                  }
                  void act(
                    () => updateUser(selected.id, patch),
                    'Profile saved.',
                    'Update failed.',
                  );
                }}
              >
                <div className="field">
                  <label htmlFor="edit-name">Display name</label>
                  <input
                    id="edit-name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="edit-email">Sign-in email</label>
                  <input
                    id="edit-email"
                    type="email"
                    required
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </div>
                <div className="field field-action">
                  <button className="btn" type="submit">
                    Save profile
                  </button>
                </div>
              </form>
              <p className="muted">
                Changing the sign-in email does not change the mailbox address. Change that on the
                Mail page.
              </p>
            </>
          ) : null}

          {canManageMembers && !self && !locked ? (
            <>
              <h3>Role</h3>
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
                    {iAmOwner ? <option value="tenant.owner">Owner</option> : null}
                  </select>
                </div>
                <div className="field field-action">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      if (
                        editRole === 'tenant.owner' &&
                        !isOwner(selected) &&
                        !window.confirm(
                          `Make ${selected.email} an owner? Owners can change everything, including you.`,
                        )
                      ) {
                        return;
                      }
                      void act(
                        () => setUserRole(selected.id, editRole === 'member' ? null : editRole),
                        'Role saved.',
                        'Role update failed.',
                      );
                    }}
                  >
                    Save role
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {!self && !locked && !shared && (canUpdate || canManageSecurity) ? (
            <>
              <h3>Sign-in</h3>
              {canUpdate ? (
                <form
                  className="form-grid"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(
                      async () => {
                        await setUserPassword(selected.id, newPassword);
                        setNewPassword('');
                      },
                      'Password set. The user was signed out everywhere.',
                      'Could not set the password.',
                    );
                  }}
                >
                  <div className="field">
                    <label htmlFor="new-password">New password</label>
                    <input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      required
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </div>
                  <div className="field field-action">
                    <button className="btn" type="submit">
                      Set password
                    </button>
                  </div>
                </form>
              ) : null}
              {canManageSecurity && selected.mfaEnabled ? (
                <div className="btn-row">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Turn off two-step verification for ${selected.email}? They can set it up again after signing in.`,
                        )
                      ) {
                        return;
                      }
                      void act(
                        () => resetUserTwoStep(selected.id),
                        'Two-step verification was turned off.',
                        'Could not reset two-step verification.',
                      );
                    }}
                  >
                    Reset two-step verification
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {canReadSecurity && !locked && !shared && !self ? (
            <>
              <h3>Sessions</h3>
              {sessions === null ? (
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    void listUserSessions(selected.id)
                      .then(setSessions)
                      .catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : 'Could not load sessions.');
                      });
                  }}
                >
                  Show sessions
                </button>
              ) : sessions.length === 0 ? (
                <p className="muted">No active sessions.</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Last seen</th>
                      <th>Address</th>
                      <th>Device</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((item) => (
                      <tr key={item.id}>
                        <td>{new Date(item.lastSeenAt).toLocaleString()}</td>
                        <td>{item.ip ?? 'Unknown'}</td>
                        <td className="muted">{item.userAgent ?? 'Unknown'}</td>
                        <td>
                          {canManageSecurity ? (
                            <button
                              className="btn btn-ghost"
                              type="button"
                              onClick={() => {
                                void revokeUserSession(selected.id, item.id)
                                  .then(() => listUserSessions(selected.id))
                                  .then(setSessions)
                                  .catch((err: unknown) => {
                                    setError(
                                      err instanceof Error ? err.message : 'Could not sign out.',
                                    );
                                  });
                              }}
                            >
                              Sign out
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : null}

          {canSuspend && !self && !locked ? (
            <>
              <h3>Access</h3>
              {selected.status === 'suspended' ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() =>
                    void act(
                      () => reinstateUser(selected.id),
                      'User reinstated.',
                      'Reinstate failed.',
                    )
                  }
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
                      onClick={() =>
                        void act(
                          () => suspendUser(selected.id, reason),
                          'User suspended.',
                          'Suspend failed.',
                        )
                      }
                    >
                      Suspend
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}
          {self ? (
            <p className="muted">
              Change your own password and two-step verification on the Security page.
            </p>
          ) : null}

          {canManageMembers && !self && !locked ? (
            <div className="btn-row">
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => {
                  if (!window.confirm(`Remove ${selected.email} from this organisation?`)) return;
                  void act(
                    async () => {
                      await removeUser(selected.id);
                      setSelected(null);
                    },
                    'User removed.',
                    'Remove failed.',
                  );
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
