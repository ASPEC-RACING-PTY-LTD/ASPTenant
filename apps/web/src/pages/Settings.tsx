import { type FormEvent, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../api.js';
import { useAuth } from '../auth.js';

export function SettingsPage() {
  const { refresh } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getSettings()
      .then((settings) => {
        setName(settings.organisation.name);
        setSlug(settings.organisation.slug);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load settings.');
      });
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await updateSettings(name.trim());
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings.');
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Identity of the organisation you are working in.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p className="notice">Organisation name saved.</p> : null}
      <section className="panel">
        <h2>Organisation</h2>
        <form onSubmit={(event) => void onSubmit(event)}>
          <div className="field">
            <label htmlFor="org-name">Name</label>
            <input id="org-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="org-slug">Slug</label>
            <input id="org-slug" value={slug} disabled />
          </div>
          <p>
            Each organisation is a separate tenant. Its users, groups, domains, mailboxes,
            applications and audit history are not visible to other organisations.
          </p>
          <button className="btn" type="submit">
            Save
          </button>
        </form>
      </section>
    </>
  );
}
