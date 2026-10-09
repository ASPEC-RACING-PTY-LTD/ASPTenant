import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { logout } from '../api.js';
import { useAuth } from '../auth.js';

const LINKS = [
  { to: '/', label: 'Dashboard', implemented: true },
  { to: '/users', label: 'Users', implemented: true },
  { to: '/groups', label: 'Groups', implemented: true },
  { to: '/mail', label: 'Mail', implemented: true },
  { to: '/applications', label: 'Applications', implemented: true },
  { to: '/domains', label: 'Domains', implemented: true },
  { to: '/security', label: 'Security', implemented: true },
  { to: '/audit', label: 'Audit', implemented: true },
  { to: '/migration', label: 'Migration', implemented: false },
  { to: '/system', label: 'System', implemented: true },
  { to: '/settings', label: 'Settings', implemented: true },
] as const;

export function AdminShell() {
  const { session, refresh, selectTenant } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const operator = session?.platform.operator === true;
  const tenants = session?.tenants ?? [];
  const onPlatformPage = location.pathname.startsWith('/tenants');
  const links = operator
    ? [...LINKS, { to: '/tenants', label: 'Tenants', implemented: true } as const]
    : LINKS;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" end>
          <img src="/logo.png" alt="" />
          <div>
            <strong>ASPECTenant</strong>
            <span>Control plane</span>
          </div>
        </NavLink>
        <nav className="nav" aria-label="Administration">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/'}
              className={({ isActive }) =>
                [isActive ? 'active' : '', link.implemented ? '' : 'planned']
                  .filter(Boolean)
                  .join(' ')
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          ASPECTenant by ASPEC TECH. Self-hosted identity and mail.
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="tenant-switch">
            {tenants.length > 1 ? (
              <>
                <label htmlFor="tenant-select">Organisation</label>
                <select
                  id="tenant-select"
                  value={session?.organisation?.id ?? ''}
                  onChange={(event) => {
                    void selectTenant(event.target.value).then(() => {
                      if (!onPlatformPage) navigate('/');
                    });
                  }}
                >
                  {tenants.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <strong>{session?.organisation?.name ?? 'No organisation'}</strong>
            )}
          </div>
          <div>
            {session?.user.email}
            <button
              className="btn btn-ghost"
              style={{ marginLeft: 12 }}
              type="button"
              onClick={() => {
                void logout().then(() => refresh());
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <div className="content">
          {session?.organisation || onPlatformPage ? (
            <Outlet key={session?.organisation?.id ?? 'platform'} />
          ) : (
            <section className="panel">
              <h2>No organisation</h2>
              <p>
                This account is not an active member of any organisation, or its organisation has
                been archived. Ask an administrator of your organisation to add or reinstate you.
              </p>
              {operator ? (
                <p>
                  As a platform operator you can manage organisations on the{' '}
                  <Link to="/tenants">Tenants</Link> page.
                </p>
              ) : null}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
