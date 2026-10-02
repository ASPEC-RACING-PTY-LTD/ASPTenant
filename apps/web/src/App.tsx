import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.js';
import { AdminShell } from './layout/AdminShell.js';
import { ApplicationsPage } from './pages/Applications.js';
import { AuditPage } from './pages/Audit.js';
import { BackupsPage } from './pages/Backups.js';
import { DashboardPage } from './pages/Dashboard.js';
import { DomainsPage } from './pages/Domains.js';
import { GroupsPage } from './pages/Groups.js';
import { LoginPage } from './pages/Login.js';
import { MailPage } from './pages/Mail.js';
import { MailClientsPage } from './pages/MailClients.js';
import { MailSettingsPage } from './pages/MailSettings.js';
import { MigrationPage } from './pages/Migration.js';
import { SecurityPage } from './pages/Security.js';
import { SettingsPage } from './pages/Settings.js';
import { SetupPage } from './pages/Setup.js';
import { SystemPage } from './pages/System.js';
import { UpdatesPage } from './pages/Updates.js';
import { UsersPage } from './pages/Users.js';
import { WebmailPage } from './pages/Webmail.js';

function Home() {
  const { session } = useAuth();
  if (!session?.permissions.includes('system:read')) return <Navigate to="/mailbox" replace />;
  return <DashboardPage />;
}

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
        <Route index element={<Home />} />
        <Route path="mailbox" element={<WebmailPage />} />
        <Route path="mail/settings" element={<MailSettingsPage />} />
        <Route path="updates" element={<UpdatesPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="mail" element={<MailPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="migration" element={<MigrationPage />} />
        <Route path="mail/clients" element={<MailClientsPage />} />
        <Route path="backups" element={<BackupsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
