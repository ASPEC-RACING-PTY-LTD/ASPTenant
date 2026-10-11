import QRCode from 'qrcode';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { beginTotp, confirmTotp, disableTotp, getMfaStatus, newRecoveryCodes } from '../api.js';
import { useAuth } from '../auth.js';

/** The signed-in person's own sign-in settings: two-step verification. */
export function AccountPage() {
  const { session } = useAuth();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesRemaining: number } | null>(
    null,
  );
  const [enrolment, setEnrolment] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [proof, setProof] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const load = useCallback(async () => {
    setStatus(await getMfaStatus());
  }, []);

  useEffect(() => {
    void load().catch(fail);
  }, [load, fail]);

  const start = async () => {
    setError(null);
    setNotice(null);
    try {
      const started = await beginTotp();
      setEnrolment({ secret: started.secret, qr: await QRCode.toDataURL(started.otpauthUri) });
      setCode('');
    } catch (err) {
      fail(err);
    }
  };

  const onConfirm = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setCodes(await confirmTotp(code.replace(/\s+/g, '')));
      setEnrolment(null);
      setNotice('Two-step verification is on. Sign-ins now ask for a code.');
      await load();
    } catch (err) {
      fail(err);
    }
  };

  // A six-digit value is a code from the app; anything else is treated as the password.
  const proofBody = () =>
    /^\d{6}$/.test(proof.trim()) ? { totp: proof.trim() } : { password: proof };

  return (
    <>
      <div className="page-header">
        <h1>Your account</h1>
        <p>Signed in as {session?.user.email}.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <section className="panel">
        <h2>Two-step verification</h2>
        <p>
          Sign-ins ask for a code from an authenticator app (Microsoft Authenticator, Google
          Authenticator, 1Password and similar) after your password. Applications that require it
          cannot be used without it.
        </p>
        {codes ? (
          <div className="notice">
            <p>
              Save these recovery codes somewhere safe. Each one signs you in once if you lose your
              phone. They are not shown again.
            </p>
            <pre>{codes.join('\n')}</pre>
            <button className="btn btn-ghost" type="button" onClick={() => setCodes(null)}>
              I have saved them
            </button>
          </div>
        ) : null}
        {status === null ? (
          <p className="muted">Loading…</p>
        ) : status.enabled ? (
          <>
            <p>
              <span className="badge badge-ok">On</span> {status.recoveryCodesRemaining} recovery
              codes left.
            </p>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="mfa-proof">Password or current code</label>
                <input
                  id="mfa-proof"
                  type="password"
                  autoComplete="current-password"
                  value={proof}
                  onChange={(event) => setProof(event.target.value)}
                />
              </div>
              <div className="field field-action">
                <div className="btn-row">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={!proof}
                    onClick={() => {
                      setError(null);
                      void newRecoveryCodes(proofBody())
                        .then((next) => {
                          setCodes(next);
                          setProof('');
                        })
                        .then(load)
                        .catch(fail);
                    }}
                  >
                    New recovery codes
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={!proof}
                    onClick={() => {
                      if (!window.confirm('Turn off two-step verification?')) return;
                      setError(null);
                      void disableTotp(proofBody())
                        .then(() => {
                          setProof('');
                          setNotice('Two-step verification is off.');
                        })
                        .then(load)
                        .catch(fail);
                    }}
                  >
                    Turn off
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : enrolment ? (
          <form onSubmit={(event) => void onConfirm(event)}>
            <ol className="steps">
              <li>Scan this code with your authenticator app.</li>
              <li>
                Or enter this key by hand: <code>{enrolment.secret}</code>
              </li>
              <li>Type the six-digit code the app shows.</li>
            </ol>
            <img
              src={enrolment.qr}
              alt="QR code for your authenticator app"
              width={200}
              height={200}
            />
            <div className="form-grid">
              <div className="field">
                <label htmlFor="mfa-confirm">Code</label>
                <input
                  id="mfa-confirm"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <div className="field field-action">
                <div className="btn-row">
                  <button className="btn" type="submit">
                    Turn on
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => setEnrolment(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </form>
        ) : (
          <>
            <p>
              <span className="badge badge-warn">Off</span>
            </p>
            <button className="btn" type="button" onClick={() => void start()}>
              Set up two-step verification
            </button>
          </>
        )}
      </section>
    </>
  );
}
