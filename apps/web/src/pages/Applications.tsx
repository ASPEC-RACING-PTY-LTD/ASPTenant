import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  createApplication,
  type DirectoryApplication,
  type DirectoryGroup,
  type DirectoryUser,
  deleteApplication,
  type IdentityProviderInfo,
  listApplications,
  listGroups,
  listSigningKeys,
  listUsers,
  rotateApplicationSecret,
  rotateSigningKey,
  type SigningKeyInfo,
  updateApplication,
} from '../api.js';
import { useAuth } from '../auth.js';

function splitUris(text: string): string[] {
  return text
    .split(/\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function when(value: number | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

/** Shown once after an application is created or its secret replaced. */
interface Revealed {
  name: string;
  clientId: string;
  clientSecret: string;
}

export function ApplicationsPage() {
  const { session } = useAuth();
  const canManage = session?.permissions.includes('apps:manage') ?? false;
  const isOperator = session?.permissions.includes('platform:admin') ?? false;
  const [items, setItems] = useState<DirectoryApplication[]>([]);
  const [provider, setProvider] = useState<IdentityProviderInfo | null>(null);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [groups, setGroups] = useState<DirectoryGroup[]>([]);
  const [keys, setKeys] = useState<SigningKeyInfo[]>([]);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [redirects, setRedirects] = useState('');
  const [clientType, setClientType] = useState<'confidential' | 'public'>('confidential');
  const [editing, setEditing] = useState<DirectoryApplication | null>(null);
  const [editRedirects, setEditRedirects] = useState('');

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const reload = useCallback(async () => {
    const list = await listApplications();
    setItems(list.items);
    setProvider(list.identityProvider);
    setEditing((current) => list.items.find((item) => item.id === current?.id) ?? null);
  }, []);

  useEffect(() => {
    void reload().catch(fail);
    void listUsers()
      .then(setUsers)
      .catch(() => undefined);
    void listGroups()
      .then(setGroups)
      .catch(() => undefined);
    if (isOperator) {
      void listSigningKeys()
        .then(setKeys)
        .catch(() => undefined);
    }
  }, [reload, fail, isOperator]);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const created = await createApplication({
        name: name.trim(),
        redirectUris: splitUris(redirects),
        clientType,
      });
      if (created.clientSecret) {
        setRevealed({
          name: created.name,
          clientId: created.clientId,
          clientSecret: created.clientSecret,
        });
      } else {
        setNotice(`${created.name} was registered. Its client ID is ${created.clientId}.`);
      }
      setName('');
      setRedirects('');
      await reload();
    } catch (err) {
      fail(err);
    }
  };

  const save = (patch: Parameters<typeof updateApplication>[1], message: string) => {
    if (!editing) return;
    setError(null);
    setNotice(null);
    void updateApplication(editing.id, patch)
      .then(() => setNotice(message))
      .then(reload)
      .catch(fail);
  };

  const toggleAssignment = (kind: 'users' | 'groups', id: string, on: boolean) => {
    if (!editing) return;
    const current = editing.assignments[kind];
    const next = on ? [...new Set([...current, id])] : current.filter((item) => item !== id);
    save({ assignments: { ...editing.assignments, [kind]: next } }, 'Access was updated.');
  };

  return (
    <>
      <div className="page-header">
        <h1>Applications</h1>
        <p>
          Applications sign people in with their ASPECTenant account over OpenID Connect
          (authorization code with PKCE). Each application belongs to this organisation and only its
          members can sign in to it.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {provider ? (
        <section className="panel">
          <h2>Provider details</h2>
          <table className="data-table">
            <tbody>
              <tr>
                <th>Issuer</th>
                <td>
                  <code>{provider.issuer}</code>
                </td>
              </tr>
              <tr>
                <th>Discovery</th>
                <td>
                  <code>{provider.discovery}</code>
                </td>
              </tr>
              <tr>
                <th>Claims</th>
                <td>
                  sub (stable account ID), email, email_verified, name, auth_time, tid (this
                  organisation&apos;s ID). Request the scopes <code>openid email profile</code>. Use{' '}
                  <code>prompt=login</code> or <code>max_age</code> to require a fresh sign-in.
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : (
        <p className="notice">
          Set the public URL under Settings to turn on sign-in. The issuer is that URL followed by
          /oidc.
        </p>
      )}
      {revealed ? (
        <section className="panel">
          <h2>Save the client secret for {revealed.name}</h2>
          <p>It is stored hashed and cannot be shown again. Replace it below if it is lost.</p>
          <table className="data-table">
            <tbody>
              <tr>
                <th>Client ID</th>
                <td>
                  <code>{revealed.clientId}</code>
                </td>
              </tr>
              <tr>
                <th>Client secret</th>
                <td>
                  <code>{revealed.clientSecret}</code>{' '}
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(revealed.clientSecret)}
                  >
                    Copy
                  </button>
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
      {canManage ? (
        <section className="panel">
          <h2>Register application</h2>
          <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
            <div className="field">
              <label htmlFor="app-name">Name</label>
              <input
                id="app-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="app-type">Type</label>
              <select
                id="app-type"
                value={clientType}
                onChange={(event) => setClientType(event.target.value as 'confidential' | 'public')}
              >
                <option value="confidential">Web application with a server (client secret)</option>
                <option value="public">Desktop or mobile app (PKCE only, no secret)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="app-redirects">Redirect URIs (one per line)</label>
              <textarea
                id="app-redirects"
                required
                rows={3}
                placeholder={
                  clientType === 'public'
                    ? 'http://127.0.0.1/callback (any port is accepted at sign-in)'
                    : 'https://portal.example.com/auth/callback'
                }
                value={redirects}
                onChange={(event) => setRedirects(event.target.value)}
              />
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Register
              </button>
            </div>
          </form>
          <p className="muted">
            Redirect URIs must match exactly. Desktop apps may register a loopback address such as
            http://127.0.0.1/callback and sign in on any port.
          </p>
        </section>
      ) : null}
      <section className="panel">
        <h2>Registered applications</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Client ID</th>
              <th>Type</th>
              <th>Who can sign in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  <div className="muted">{item.redirectUris.join(', ')}</div>
                </td>
                <td>
                  <code>{item.clientId}</code>
                </td>
                <td>
                  {item.clientType === 'public' ? 'Public (PKCE)' : 'Confidential'}
                  {item.clientType === 'confidential' ? (
                    <div className="muted">
                      {item.hasSecret
                        ? `Secret set ${when(item.secretCreatedAt)}`
                        : 'No secret yet'}
                    </div>
                  ) : null}
                </td>
                <td>
                  {item.requireAssignment
                    ? `${item.assignments.users.length} people, ${item.assignments.groups.length} groups`
                    : 'Every member'}
                  {item.requireMfa ? (
                    <div className="muted">Two-step verification required</div>
                  ) : null}
                </td>
                <td className="btn-row">
                  {canManage ? (
                    <>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => {
                          setEditing(item);
                          setEditRedirects(item.redirectUris.join('\n'));
                        }}
                      >
                        Manage
                      </button>
                      {item.clientType === 'confidential' ? (
                        <button
                          className="btn btn-ghost"
                          type="button"
                          onClick={() => {
                            if (
                              item.hasSecret &&
                              !window.confirm(
                                `Replace the client secret of ${item.name}? The current one stops working at once.`,
                              )
                            )
                              return;
                            setError(null);
                            void rotateApplicationSecret(item.id)
                              .then((clientSecret) =>
                                setRevealed({
                                  name: item.name,
                                  clientId: item.clientId,
                                  clientSecret,
                                }),
                              )
                              .then(reload)
                              .catch(fail);
                          }}
                        >
                          {item.hasSecret ? 'New secret' : 'Create secret'}
                        </button>
                      ) : null}
                      <button
                        className="btn btn-danger"
                        type="button"
                        onClick={() => {
                          if (!window.confirm(`Delete ${item.name}? Its sign-ins stop at once.`))
                            return;
                          void deleteApplication(item.id).then(reload).catch(fail);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editing && canManage ? (
        <section className="panel">
          <h2>{editing.name}</h2>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              save({ redirectUris: splitUris(editRedirects) }, 'Redirect URIs were saved.');
            }}
          >
            <div className="field">
              <label htmlFor="edit-redirects">Redirect URIs</label>
              <textarea
                id="edit-redirects"
                rows={3}
                value={editRedirects}
                onChange={(event) => setEditRedirects(event.target.value)}
              />
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Save redirect URIs
              </button>
            </div>
          </form>
          <div className="btn-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={editing.requireMfa}
                onChange={(event) =>
                  save(
                    { requireMfa: event.target.checked },
                    event.target.checked
                      ? 'People now need two-step verification to sign in.'
                      : 'Two-step verification is no longer required.',
                  )
                }
              />{' '}
              Require two-step verification
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={editing.requireAssignment}
                onChange={(event) =>
                  save(
                    { requireAssignment: event.target.checked },
                    event.target.checked
                      ? 'Only the people and groups below can sign in now.'
                      : 'Every member can sign in now.',
                  )
                }
              />{' '}
              Only assigned people and groups can sign in
            </label>
          </div>
          {editing.requireAssignment ? (
            <div className="form-grid">
              <div className="field">
                <span>People</span>
                {users.map((user) => (
                  <label key={user.id} className="toggle">
                    <input
                      type="checkbox"
                      checked={editing.assignments.users.includes(user.id)}
                      onChange={(event) => toggleAssignment('users', user.id, event.target.checked)}
                    />{' '}
                    {user.displayName ? `${user.displayName} (${user.email})` : user.email}
                  </label>
                ))}
              </div>
              <div className="field">
                <span>Groups</span>
                {groups.length === 0 ? <p className="muted">No groups yet.</p> : null}
                {groups.map((group) => (
                  <label key={group.id} className="toggle">
                    <input
                      type="checkbox"
                      checked={editing.assignments.groups.includes(group.id)}
                      onChange={(event) =>
                        toggleAssignment('groups', group.id, event.target.checked)
                      }
                    />{' '}
                    {group.name}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {isOperator && provider ? (
        <section className="panel">
          <h2>Token signing keys</h2>
          <p className="muted">
            Installation-wide. A new key signs from now on; earlier keys stay published so tokens
            they signed keep verifying until they expire.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Key ID</th>
                <th>Created</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.kid}>
                  <td>
                    <code>{key.kid}</code>
                  </td>
                  <td>{when(key.createdAt)}</td>
                  <td>{key.active ? 'Signing' : 'Published for verification'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="btn-row">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                if (!window.confirm('Sign tokens with a new key from now on?')) return;
                void rotateSigningKey().then(setKeys).catch(fail);
              }}
            >
              Rotate signing key
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
