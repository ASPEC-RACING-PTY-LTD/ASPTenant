import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  createImport,
  type DirectoryMailbox,
  deleteImport,
  type ImportJob,
  listImports,
  listMailboxes,
  retryImport,
  uploadImportChunk,
} from '../api.js';

const CHUNK = 16 * 1024 * 1024;

// Browsers refuse to read a file that is locked or was modified after it was chosen. Outlook
// does both to a PST it has open, so the upload cannot continue until the file is released.
const FILE_UNREADABLE =
  'The browser could not read the file. It is probably still open in Outlook or another program, or it changed after you chose it. Close Outlook (or copy the PST somewhere else) and choose the file again';

async function readChunk(file: File, offset: number): Promise<ArrayBuffer> {
  try {
    return await file.slice(offset, offset + CHUNK).arrayBuffer();
  } catch {
    throw new Error(FILE_UNREADABLE);
  }
}

export function MigrationPage() {
  const [mailboxes, setMailboxes] = useState<DirectoryMailbox[]>([]);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [mailboxId, setMailboxId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setJobs(await listImports());
  }, []);

  useEffect(() => {
    void Promise.all([listMailboxes(), listImports()])
      .then(([boxes, items]) => {
        setMailboxes(boxes);
        setJobs(items);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) return;
    const timer = setInterval(() => void reload().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [jobs, reload]);

  const onUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !mailboxId) return;
    setError(null);
    try {
      let job = await createImport({ mailboxId, filename: file.name, size: file.size });
      let offset = job.data.received;
      setUpload({ sent: offset, total: file.size });
      while (offset < file.size) {
        // Read the chunk before sending it, so a locked or changed file is reported clearly
        // instead of failing as a network error on every retry.
        const chunk = await readChunk(file, offset);
        let attempt = 0;
        for (;;) {
          try {
            job = await uploadImportChunk(job.id, offset, chunk);
            break;
          } catch (err) {
            attempt += 1;
            const expected = /Expected offset (\d+)/.exec(err instanceof Error ? err.message : '');
            if (expected) {
              offset = Number(expected[1]);
              break;
            }
            if (attempt >= 5) throw err;
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          }
        }
        offset = job.data.received > offset ? job.data.received : offset;
        setUpload({ sent: offset, total: file.size });
      }
      setUpload(null);
      setFile(null);
      await reload();
    } catch (err) {
      setUpload(null);
      setError(
        `${err instanceof Error ? err.message : String(err)}. Choose the same file again to resume the upload.`,
      );
    }
  };

  const mailboxName = (id: string) =>
    mailboxes.find((item) => item.id === id)?.primaryAddress ?? id;

  return (
    <>
      <div className="page-header">
        <h1>Migration</h1>
        <p>
          Import Outlook PST files (for example exported from Microsoft 365) into a mailbox.
          Folders, sent and received mail, attachments, dates and read state are kept. Importing the
          same file again skips messages that are already there.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Import a PST file</h2>
        <form className="form-grid" onSubmit={(event) => void onUpload(event)}>
          <div className="field">
            <label htmlFor="imp-source">Import from</label>
            <select id="imp-source" defaultValue="pst">
              <option value="pst">Outlook data file (.pst)</option>
              <option value="exchange" disabled>
                Exchange / Microsoft 365 export (coming later)
              </option>
              <option value="azure" disabled>
                Azure / Entra backup (coming later)
              </option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-mailbox">Into mailbox</label>
            <select
              id="imp-mailbox"
              value={mailboxId}
              onChange={(e) => setMailboxId(e.target.value)}
              required
            >
              <option value="">Select a mailbox</option>
              {mailboxes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.primaryAddress}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="imp-file">PST file</label>
            <input
              id="imp-file"
              type="file"
              accept=".pst"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="field field-action">
            <button className="btn" type="submit" disabled={Boolean(upload)}>
              {upload
                ? `Uploading ${Math.floor((upload.sent / upload.total) * 100)}%`
                : 'Upload and import'}
            </button>
          </div>
        </form>
        <details>
          <summary>How to export a PST from Outlook (classic)</summary>
          <ol className="steps">
            <li>
              If the account is Microsoft 365 or Exchange, first turn off Cached Exchange Mode
              (File, Account Settings, Account Settings, Change) or set the cache slider to All.
              Otherwise Outlook only exports the cached period, 12 months by default.
            </li>
            <li>
              File, Open &amp; Export, Import/Export, Export to a file, Outlook Data File (.pst).
            </li>
            <li>Select the mailbox at the top of the list and tick Include subfolders.</li>
            <li>Save the file somewhere outside OneDrive, leave the password blank, and Finish.</li>
            <li>
              Upload it here. Calendar, contacts and tasks in the file are skipped; mail folders are
              kept.
            </li>
          </ol>
        </details>
        <p className="muted">
          Large files upload in 16 MB pieces and resume after a dropped connection. Keep this page
          open until the upload finishes; the import itself runs on the server.
        </p>
      </section>
      <section className="panel">
        <h2>Imports</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Mailbox</th>
              <th>Status</th>
              <th>Progress</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.data.filename}</td>
                <td>{mailboxName(job.data.mailboxId)}</td>
                <td>
                  <span
                    className={`badge ${job.status === 'succeeded' ? 'badge-ok' : job.status === 'failed' ? 'badge-warn' : 'badge-off'}`}
                  >
                    {job.status}
                  </span>
                  {job.error ? <div className="muted">{job.error}</div> : null}
                </td>
                <td>
                  {job.status === 'uploading'
                    ? `Uploaded ${Math.floor((job.data.received / job.data.size) * 100)}%`
                    : `${job.progress.processed}/${job.progress.total} processed, ${job.progress.imported} imported, ${job.progress.skipped} skipped, ${job.progress.failed} failed`}
                  {job.progress.folder ? <div className="muted">{job.progress.folder}</div> : null}
                </td>
                <td className="btn-row">
                  {job.status === 'failed' || job.status === 'succeeded' ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() =>
                        void retryImport(job.id)
                          .then(reload)
                          .catch((err: unknown) => setError(String(err)))
                      }
                    >
                      Run again
                    </button>
                  ) : null}
                  {job.status !== 'running' ? (
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => {
                        if (
                          !window.confirm(
                            'Remove this import and its uploaded file? Imported mail stays.',
                          )
                        )
                          return;
                        void deleteImport(job.id)
                          .then(reload)
                          .catch((err: unknown) => setError(String(err)));
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
