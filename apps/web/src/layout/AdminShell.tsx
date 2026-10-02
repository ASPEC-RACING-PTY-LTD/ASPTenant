import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { logout } from '../api.js';
import { useAuth } from '../auth.js';

const LINKS: ReadonlyArray<{
  to: string;
  label: string;
  implemented: boolean;
  permission: string | null;
}> = [
  { to: '/', label: 'Dashboard', implemented: true, permission: 'system:read' },
  { to: '/mailbox', label: 'Mailbox', implemented: true, permission: null },
  { to: '/users', label: 'Users', implemented: true, permission: 'users:read' },
  { to: '/groups', label: 'Groups', implemented: true, permission: 'groups:read' },
  { to: '/mail', label: 'Mail', implemented: true, permission: 'mail:read' },
  { to: '/mail/settings', label: 'Mail settings', implemented: true, permission: 'mail:manage' },
  { to: '/mail/clients', label: 'Mail apps', implemented: true, permission: 'mail:manage' },
  { to: '/domains', label: 'Domains', implemented: true, permission: 'domains:read' },
  { to: '/applications', label: 'Applications', implemented: true, permission: 'apps:read' },
  { to: '/security', label: 'Security', implemented: true, permission: 'security:read' },
  { to: '/audit', label: 'Audit', implemented: true, permission: 'audit:read' },
  { to: '/migration', label: 'Migration', implemented: true, permission: 'migration:read' },
  { to: '/system', label: 'System', implemented: true, permission: 'system:read' },
  { to: '/backups', label: 'Backups', implemented: true, permission: 'platform:admin' },
  { to: '/updates', label: 'Updates', implemented: true, permission: 'platform:admin' },
  { to: '/settings', label: 'Settings', implemented: true, permission: 'orgs:settings' },
];

export function AdminShell() {
  const { session, refresh } = useAuth();
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('aspectenant-theme', next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this page.
    }
    setTheme(next);
  };

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
          {LINKS.filter(
            (link) => !link.permission || session?.permissions.includes(link.permission),
          ).map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/' || link.to === '/mail'}
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
              className="btn btn-ghost theme-toggle"
              type="button"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
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
