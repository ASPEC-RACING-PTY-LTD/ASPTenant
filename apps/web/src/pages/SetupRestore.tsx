import { type FormEvent, useState } from 'react';
import { setupRestore } from '../api.js';

/** Disaster recovery on a fresh install: restore the latest (or a named) backup. */
export function SetupRestore() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    setupCode: '',
    endpoint: '',
    region: 'auto',
    bucket: '',
    prefix: 'aspectenant/',
    accessKeyId: '',
    secretAccessKey: '',
    passphrase: '',
    key: '',
  });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (name: keyof typeof values, label: string, type = 'text') => (
    <div className="field">
      <label htmlFor={`r-${name}`}>{label}</label>
      <input
        id={`r-${name}`}
        type={type}
        autoComplete="off"
        value={values[name]}
        onChange={(event) => setValues({ ...values, [name]: event.target.value })}
      />
    </div>
  );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus('Downloading and restoring. Large mailboxes take a while.');
    try {
      const result = await setupRestore({
        setupCode: values.setupCode.trim(),
        passphrase: values.passphrase,
        ...(values.key.trim() ? { key: values.key.trim() } : {}),
        s3: {
          endpoint: values.endpoint.trim(),
          region: values.region.trim() || 'auto',
          bucket: values.bucket.trim(),
          prefix: values.prefix.trim(),
          accessKeyId: values.accessKeyId.trim(),
          secretAccessKey: values.secretAccessKey.trim(),
          forcePathStyle: false,
        },
      });
      setStatus(
        `Restored ${result.key} (${result.rows} records). The server is restarting; sign in with your existing account in a minute.`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <p>
        <button className="btn btn-ghost" type="button" onClick={() => setOpen(true)}>
          Restore from backup instead
        </button>
      </p>
    );
  }
  return (
    <form className="auth-card" onSubmit={(event) => void onSubmit(event)}>
      <h1>Restore from backup</h1>
      {status ? <p className="notice">{status}</p> : null}
      {field('setupCode', 'Setup code')}
      {field('endpoint', 'S3 endpoint (R2: https://<account>.r2.cloudflarestorage.com)')}
      {field('region', 'Region')}
      {field('bucket', 'Bucket')}
      {field('prefix', 'Folder prefix')}
      {field('accessKeyId', 'Access key ID')}
      {field('secretAccessKey', 'Secret access key', 'password')}
      {field('passphrase', 'Backup encryption passphrase', 'password')}
      {field('key', 'Backup file (blank for the latest)')}
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Restoring…' : 'Restore'}
      </button>
    </form>
  );
}
