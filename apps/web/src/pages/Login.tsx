import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { getSetupState } from '../api.js';
import { useAuth } from '../auth.js';
import { SignInForm } from '../layout/SignInForm.js';

export function LoginPage() {
  const { session, refresh } = useAuth();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

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

  return (
    <div className="auth-page">
      <div className="auth-brand">
        <img src="/logo.png" alt="" />
        <strong>ASPECTenant</strong>
      </div>
      <div className="auth-card">
        <h1>Sign in</h1>
        <p>Administer this organisation's identities, access and mail.</p>
        <SignInForm onSignedIn={refresh} />
        <p>
          First installation? <Link to="/setup">Create the first account</Link>
        </p>
      </div>
    </div>
  );
}
