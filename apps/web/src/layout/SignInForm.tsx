import { type FormEvent, useState } from 'react';
import { completeMfa, login } from '../api.js';

/**
 * Email and password, then a code from the authenticator app (or a recovery code) when
 * two-step verification is on. Calls onSignedIn once a session exists.
 */
export function SignInForm({
  initialEmail = '',
  submitLabel = 'Sign in',
  onSignedIn,
}: {
  initialEmail?: string;
  submitLabel?: string;
  onSignedIn: () => Promise<void> | void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setPending(false);
    }
  };

  const onPassword = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const step = await login(email, password);
      setPassword('');
      if (step.status === 'mfa_required') {
        setChallenge(step.challengeToken);
        return;
      }
      await onSignedIn();
    });
  };

  const onCode = (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    void run(async () => {
      const value = code.trim();
      await completeMfa(
        challenge,
        useRecovery ? { recoveryCode: value } : { code: value.replace(/\s+/g, '') },
      );
      await onSignedIn();
    });
  };

  const notice = error ? (
    <p className="notice notice-error" role="alert">
      {error}
    </p>
  ) : null;

  if (challenge) {
    return (
      <form onSubmit={onCode}>
        {notice}
        <div className="field">
          <label htmlFor="mfa-code">
            {useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
          </label>
          <input
            id="mfa-code"
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Verify'}
        </button>
        <p>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode('');
            }}
          >
            {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
          </button>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={onPassword}>
      {notice}
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
        {pending ? 'Signing in…' : submitLabel}
      </button>
    </form>
  );
}
