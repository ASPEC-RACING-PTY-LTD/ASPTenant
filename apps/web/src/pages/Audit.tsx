import { type FormEvent, useEffect, useState } from 'react';
import { type AuditEvent, listAudit } from '../api.js';

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [category, setCategory] = useState('');

  const reload = async () => {
    setEvents(
      await listAudit({
        ...(prefix.trim() ? { actionPrefix: prefix.trim() } : {}),
        ...(category ? { category } : {}),
      }),
    );
  };

  useEffect(() => {
    void listAudit({})
      .then(setEvents)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load audit events.');
      });
  }, []);

  const onFilter = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load audit events.');
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Audit</h1>
        <p>Append-only administrative and security history recorded by the control plane.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Filter</h2>
        <form className="form-grid" onSubmit={(event) => void onFilter(event)}>
          <div className="field">
            <label htmlFor="audit-prefix">Action prefix</label>
            <input
              id="audit-prefix"
              placeholder="directory. or auth."
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="audit-category">Category</label>
            <select
              id="audit-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All</option>
              <option value="security">Security</option>
              <option value="admin">Admin</option>
              <option value="data">Data</option>
              <option value="system">System</option>
            </select>
          </div>
          <div className="field field-action">
            <button className="btn" type="submit">
              Apply
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>Events</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Actor</th>
              <th>Resource</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.timestamp).toLocaleString()}</td>
                <td>{event.action}</td>
                <td>{event.outcome}</td>
                <td>{event.actor?.id ?? 'system'}</td>
                <td>
                  {event.resource
                    ? `${event.resource.type}${event.resource.id ? ` ${event.resource.id}` : ''}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
