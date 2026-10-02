import { type FormEvent, useEffect, useState } from 'react';
import {
  type AuthSession,
  changePassword,
  listAuthSessions,
  listRoles,
  revokeAuthSession,
  revokeOtherAuthSessions,
  type SecurityRole,
} from '../api.js';

export function SecurityPage() {
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [roles, setRoles] = useState<SecurityRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saved, setSaved] = useState(false);

  const reload = async () => {
    const [nextSessions, nextRoles] = await Promise.all([listAuthSessions(), listRoles()]);
    setSessions(nextSessions);
    setRoles(nextRoles);
  };

  useEffect(() => {
    void Promise.all([listAuthSessions(), listRoles()])
      .then(([nextSessions, nextRoles]) => {
        setSessions(nextSessions);
        setRoles(nextRoles);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load security data.');
      });
  }, []);

  const onPassword = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed.');
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Security</h1>
        <p>Session administration and password change. MFA and passkeys are not exposed yet.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p className="notice">Password changed. Other sessions were revoked.</p> : null}
      <section className="panel">
        <h2>Your sessions</h2>
        <div className="toolbar">
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              void revokeOtherAuthSessions()
                .then(reload)
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : 'Could not revoke sessions.');
                });
            }}
          >
            Revoke other sessions
          </button>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Last seen</th>
              <th>IP</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  {new Date(session.createdAt).toLocaleString()}
                  {session.current ? ' (current)' : ''}
                </td>
                <td>{new Date(session.lastSeenAt).toLocaleString()}</td>
                <td>{session.ip ?? 'unknown'}</td>
                <td>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => {
                      void revokeAuthSession(session.id)
                        .then(reload)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Revoke failed.');
                        });
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Change password</h2>
        <form onSubmit={(event) => void onPassword(event)}>
          <div className="field">
            <label htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              minLength={12}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <button className="btn" type="submit">
            Change password
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Roles</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Permissions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.key}>
                <td>
                  <strong>{role.name}</strong>
                  <div>{role.description}</div>
                </td>
                <td>{role.permissions.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
