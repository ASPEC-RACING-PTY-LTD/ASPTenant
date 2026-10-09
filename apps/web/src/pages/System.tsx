import { useEffect, useState } from 'react';
import { getReadiness, getSystem, type HealthReport, type SystemDiagnostics } from '../api.js';

export function SystemPage() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [system, setSystem] = useState<SystemDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getReadiness(), getSystem()])
      .then(([nextHealth, nextSystem]) => {
        setHealth(nextHealth);
        setSystem(nextSystem);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Health probe failed.');
      });
  }, []);

  const uptimeMinutes = system ? Math.floor(system.uptimeMs / 60_000) : null;

  return (
    <>
      <div className="page-header">
        <h1>System</h1>
        <p>Readiness of the control plane process and its PostgreSQL (or test SQLite) store.</p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Checks</h2>
        <table className="table">
          <tbody>
            <tr>
              <th>Overall</th>
              <td>
                <span className={`badge ${health?.status === 'ok' ? 'badge-ok' : 'badge-warn'}`}>
                  {health?.status ?? 'loading'}
                </span>
              </td>
            </tr>
            {health?.checks
              ? Object.entries(health.checks).map(([name, check]) => (
                  <tr key={name}>
                    <th>{name}</th>
                    <td>
                      {check.status}
                      {check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ''}
                    </td>
                  </tr>
                ))
              : null}
            {system ? (
              <>
                <tr>
                  <th>Dialect</th>
                  <td>{system.database.dialect}</td>
                </tr>
                <tr>
                  <th>Tenant isolation</th>
                  <td>
                    {system.isolation ? (
                      <>
                        <span
                          className={`badge ${system.isolation.rowLevelSecurity.enforced ? 'badge-ok' : 'badge-warn'}`}
                        >
                          {system.isolation.rowLevelSecurity.enforced
                            ? 'row-level security enforced'
                            : 'tenant-scoped queries only'}
                        </span>{' '}
                        {system.isolation.rowLevelSecurity.detail}
                      </>
                    ) : (
                      'unknown'
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Uptime</th>
                  <td>{uptimeMinutes === 0 ? 'under 1 minute' : `${uptimeMinutes} minutes`}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
      </section>
      {system ? (
        <section className="panel">
          <h2>Counts for this organisation</h2>
          <table className="table">
            <tbody>
              {Object.entries(system.counts).map(([name, value]) => (
                <tr key={name}>
                  <th>{name}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
