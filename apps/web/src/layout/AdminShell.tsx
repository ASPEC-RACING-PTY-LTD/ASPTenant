import { NavLink, Outlet } from 'react-router-dom';
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
  const { session, refresh } = useAuth();

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
          {LINKS.map((link) => (
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
          <div>{session?.organisation.name ?? 'ASPECTenant'}</div>
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
          <Outlet />
        </div>
      </div>
    </div>
  );
}
