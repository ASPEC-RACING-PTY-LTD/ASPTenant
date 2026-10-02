import { type FormEvent, useEffect, useState } from 'react';
import {
  createApplication,
  type DirectoryApplication,
  deleteApplication,
  listApplications,
} from '../api.js';

export function ApplicationsPage() {
  const [items, setItems] = useState<DirectoryApplication[]>([]);
  const [name, setName] = useState('');
  const [redirects, setRedirects] = useState('http://localhost:3000/callback');
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setItems(await listApplications());
  };

  useEffect(() => {
    void listApplications()
      .then(setItems)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load applications.');
      });
  }, []);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await createApplication(
        name.trim(),
        redirects
          .split(/\n|,/)
          .map((value) => value.trim())
          .filter(Boolean),
      );
      setName('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register the application.');
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Applications</h1>
        <p>
          Store OIDC client registrations for later identity-provider work. SoftDock will integrate
          here as an external application, not as part of this process.
        </p>
      </div>
      <p className="notice">
        No OIDC or SAML identity provider is running. These records are a directory only.
      </p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Register application</h2>
        <form onSubmit={(event) => void onCreate(event)}>
          <div className="field">
            <label htmlFor="app-name">Name</label>
            <input id="app-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="app-redirects">Redirect URIs (one per line)</label>
            <textarea
              id="app-redirects"
              rows={3}
              value={redirects}
              onChange={(e) => setRedirects(e.target.value)}
            />
          </div>
          <button className="btn" type="submit">
            Register
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>Registrations</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Client ID</th>
              <th>Redirects</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>
                  <code>{item.clientId}</code>
                </td>
                <td>{item.redirectUris.join(', ')}</td>
                <td>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      void deleteApplication(item.id)
                        .then(reload)
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
    </>
  );
}
