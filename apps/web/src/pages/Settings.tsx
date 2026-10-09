import { type FormEvent, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../api.js';
import { useAuth } from '../auth.js';
import { DomainConnectSettingsPanel } from './DomainConnectSettings.js';

export function SettingsPage() {
  const { refresh, session } = useAuth();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('Settings saved.');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getSettings()
      .then((settings) => {
        setName(settings.organisation.name);
        setSlug(settings.organisation.slug);
        setPublicUrl(settings.publicUrl ?? '');
        setSavedUrl(settings.publicUrl);
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
      const result = await updateSettings(name.trim(), publicUrl.trim() || null);
      setSavedUrl(result.publicUrl);
      setMessage(
        result.restarting
          ? 'Saved. The server restarts to apply the public URL; sign in again in a few seconds.'
          : 'Settings saved.',
      );
      setSaved(true);
      if (!result.restarting) await refresh();
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
      {saved ? <p className="notice">{message}</p> : null}
      {!savedUrl ? (
        <p className="notice">
          Set the public URL people use to open this panel (for example your Cloudflare Tunnel
          hostname). It is used for secure cookies and the Cloudflare Worker address.
        </p>
      ) : null}
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
          {session?.platform.operator ? (
            <div className="field">
              <label htmlFor="public-url">Public URL (whole installation)</label>
              <input
                id="public-url"
                placeholder="https://mail.example.com"
                value={publicUrl}
                onChange={(e) => setPublicUrl(e.target.value)}
              />
            </div>
          ) : null}
          <p>
            Each organisation is a separate tenant. Its users, groups, domains, mailboxes,
            applications and audit history are not visible to other organisations.
          </p>
          <button className="btn" type="submit">
            Save
          </button>
        </form>
      </section>
      {session?.platform.operator ? <DomainConnectSettingsPanel /> : null}
    </>
  );
}
