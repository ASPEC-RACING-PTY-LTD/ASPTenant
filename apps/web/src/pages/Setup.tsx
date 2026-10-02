import { type FormEvent, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { completeSetup, getSetupState, login } from '../api.js';
import { useAuth } from '../auth.js';

export function SetupPage() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [ready, setReady] = useState<boolean | null>(null);
  const [organisationName, setOrganisationName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void getSetupState()
      .then((state) => setReady(state.required))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not read setup state.');
        setReady(false);
      });
  }, []);

  if (session) return <Navigate to="/" replace />;
  if (ready === false) return <Navigate to="/login" replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await completeSetup({
        email,
        password,
        organisationName: organisationName.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      await login(email, password);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
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
        <h1>Create the super administrator</h1>
        <p>
          Name the organisation and create the first owner account. This form closes after that
          account exists.
        </p>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="organisationName">Organisation</label>
          <input
            id="organisationName"
            name="organisation"
            autoComplete="organization"
            value={organisationName}
            onChange={(event) => setOrganisationName(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="displayName">Your name</label>
          <input
            id="displayName"
            name="name"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </div>
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
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="confirmPassword">Confirm password</label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={pending || ready !== true}>
          {pending ? 'Creating account…' : 'Create super administrator'}
        </button>
        <p>
          Already set up? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
