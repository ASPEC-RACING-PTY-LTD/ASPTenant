import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  cancelSignIn,
  continueSignIn,
  getSignInRequest,
  logout,
  type SignInRequest,
} from '../api.js';
import { SignInForm } from '../layout/SignInForm.js';

/** Sign-in for an application that uses ASPECTenant as its OpenID Connect provider. */
export function SignInPage() {
  const { uid = '' } = useParams();
  const [request, setRequest] = useState<SignInRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    setRequest(await getSignInRequest(uid));
  }, [uid]);

  useEffect(() => {
    void load().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'This sign-in request could not be loaded.');
    });
  }, [load]);

  const go = async (task: () => Promise<string>) => {
    setPending(true);
    setError(null);
    try {
      window.location.assign(await task());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setPending(false);
      await load().catch(() => undefined);
    }
  };

  const proceed = () => go(() => continueSignIn(uid));

  const signedIn = request?.signedInAs && !switching;

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img src="/logo.png" alt="" />
        <strong>ASPECTenant</strong>
      </div>
      <div className="auth-card">
        <h1>{request ? `Sign in to ${request.application}` : 'Sign in'}</h1>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        {request?.refusal && signedIn ? (
          <>
            <p className="notice notice-error" role="alert">
              {request.refusal}
            </p>
            <div className="btn-row">
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => void logout().then(() => setSwitching(true))}
              >
                Use another account
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => void go(() => cancelSignIn(uid))}
              >
                Cancel
              </button>
            </div>
          </>
        ) : request && signedIn ? (
          <>
            <p>You are signed in as {request.signedInAs}.</p>
            <div className="btn-row">
              <button
                className="btn"
                type="button"
                disabled={pending}
                onClick={() => void proceed()}
              >
                {pending ? 'Continuing…' : 'Continue'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => void logout().then(() => setSwitching(true))}
              >
                Use another account
              </button>
            </div>
          </>
        ) : request ? (
          <>
            <p>
              {request.reauthenticate
                ? `${request.application} asks you to confirm it is you. Sign in again to continue.`
                : `Use your ASPECTenant account to continue to ${request.application}.`}
            </p>
            <SignInForm
              initialEmail={switching ? '' : (request.email ?? '')}
              submitLabel="Sign in and continue"
              onSignedIn={async () => {
                setSwitching(false);
                const next = await getSignInRequest(uid);
                setRequest(next);
                if (next.signedInAs && !next.refusal) await proceed();
              }}
            />
            <p>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => void go(() => cancelSignIn(uid))}
              >
                Cancel and return to {request.application}
              </button>
            </p>
          </>
        ) : error ? null : (
          <p className="muted">Loading…</p>
        )}
      </div>
    </div>
  );
}
