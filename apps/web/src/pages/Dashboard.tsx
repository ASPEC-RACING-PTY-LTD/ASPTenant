import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type AuditEvent,
  getReadiness,
  getSystem,
  type HealthReport,
  listAudit,
  type SystemDiagnostics,
} from '../api.js';
import { useAuth } from '../auth.js';

function roleLabel(role: string | undefined): string {
  if (role === 'owner') return 'Super administrator';
  if (role === 'admin') return 'Administrator';
  if (role === 'auditor') return 'Auditor';
  return role ?? 'Member';
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function actionLabel(action: string): string {
  return action.replace(/\./g, ' · ');
}

export function DashboardPage() {
  const { session } = useAuth();
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [system, setSystem] = useState<SystemDiagnostics | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getReadiness(), getSystem(), listAudit({ limit: 8 })])
      .then(([nextHealth, nextSystem, nextEvents]) => {
        setHealth(nextHealth);
        setSystem(nextSystem);
        setEvents(nextEvents);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load the dashboard.');
      });
  }, []);

  const ready = health?.status === 'ok';
  const displayName = session?.user.displayName || session?.user.email || 'Administrator';
  const counts = system?.counts;

  return (
    <>
      <div className="page-header dash-head">
        <div>
          <h1>{session?.organisation.name ?? 'Organisation'}</h1>
          <p>
            {displayName}
            {session?.membership?.role ? ` · ${roleLabel(session.membership.role)}` : ''}
          </p>
        </div>
        <span className={`badge ${ready ? 'badge-ok' : health ? 'badge-warn' : 'badge-off'}`}>
          {health ? (ready ? 'Ready' : health.status) : 'Checking'}
        </span>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="metric-grid">
        <Link className="metric" to="/users">
          <span>People</span>
          <strong>{counts ? counts.users : '…'}</strong>
        </Link>
        <Link className="metric" to="/groups">
          <span>Groups</span>
          <strong>{counts ? counts.groups : '…'}</strong>
        </Link>
        <Link className="metric" to="/mail">
          <span>Mailboxes</span>
          <strong>{counts ? counts.mailboxes : '…'}</strong>
        </Link>
        <Link className="metric" to="/domains">
          <span>Domains</span>
          <strong>{counts ? counts.domains : '…'}</strong>
        </Link>
        <Link className="metric" to="/applications">
          <span>Applications</span>
          <strong>{counts ? counts.applications : '…'}</strong>
        </Link>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent activity</h2>
          <Link to="/audit">Full history</Link>
        </div>
        {events === null ? (
          <p className="muted">Loading activity.</p>
        ) : events.length === 0 ? (
          <p className="muted">No administrative actions have been recorded yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatWhen(event.timestamp)}</td>
                  <td>{actionLabel(event.action)}</td>
                  <td>
                    <span
                      className={`badge ${event.outcome === 'success' ? 'badge-ok' : 'badge-warn'}`}
                    >
                      {event.outcome}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
