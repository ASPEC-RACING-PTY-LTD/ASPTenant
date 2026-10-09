import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.js';
import { AdminShell } from './layout/AdminShell.js';
import { ApplicationsPage } from './pages/Applications.js';
import { AuditPage } from './pages/Audit.js';
import { DashboardPage } from './pages/Dashboard.js';
import { DomainsPage } from './pages/Domains.js';
import { GroupsPage } from './pages/Groups.js';
import { LoginPage } from './pages/Login.js';
import { MailPage } from './pages/Mail.js';
import { PlannedPage } from './pages/Planned.js';
import { SecurityPage } from './pages/Security.js';
import { SettingsPage } from './pages/Settings.js';
import { SetupPage } from './pages/Setup.js';
import { SystemPage } from './pages/System.js';
import { TenantsPage } from './pages/Tenants.js';
import { UsersPage } from './pages/Users.js';

function RequireSession({ children }: { children: ReactNode }) {
  const { loading, session } = useAuth();
  if (loading) return <p className="content">Loading session…</p>;
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route
        path="/"
        element={
          <RequireSession>
            <AdminShell />
          </RequireSession>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="mail" element={<MailPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="migration" element={<PlannedPage area="migration" />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="tenants" element={<TenantsPage />} />
      </Route>
    </Routes>
  );
}
