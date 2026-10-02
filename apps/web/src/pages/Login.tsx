import { type FormEvent, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { getSetupState, login } from '../api.js';
import { useAuth } from '../auth.js';

export function LoginPage() {
  const { session, refresh } = useAuth();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void getSetupState()
      .then((state) => setSetupRequired(state.required))
      .catch(() => setSetupRequired(false));
  }, []);

  if (session) return <Navigate to="/" replace />;
  if (setupRequired === true) return <Navigate to="/setup" replace />;
  if (setupRequired === null) {
    return (
      <div className="auth-page">
        <div className="auth-brand">
          <img src="/logo.png" alt="" />
          <strong>ASPECTenant</strong>
        </div>
      </div>
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(email, password);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img src="/logo.png" alt="" />
        <strong>ASPECTenant</strong>
      </div>
      <form className="auth-card" onSubmit={(event) => void onSubmit(event)}>
        <h1>Sign in</h1>
        <p>Administer this organisation's identities, access and mail.</p>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <p>
          First installation? <Link to="/setup">Create the super administrator</Link>
        </p>
      </form>
    </div>
  );
}
