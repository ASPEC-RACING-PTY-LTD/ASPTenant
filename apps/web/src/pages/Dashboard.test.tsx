import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './Dashboard.js';

vi.mock('../auth.js', () => ({
  useAuth: () => ({
    loading: false,
    session: {
      account: { id: '1', email: 'owner@example.com', emailVerified: true, mfaEnabled: false },
      user: { id: '1', email: 'owner@example.com', displayName: 'Alex Rivera', status: 'active' },
      organisation: { id: 'default', name: 'Contoso', slug: 'contoso', status: 'active' },
      membership: { role: 'owner', status: 'active' },
      roles: ['tenant.owner'],
      permissions: ['users:read'],
      tenants: [{ id: 'default', name: 'Contoso', slug: 'contoso', role: 'owner' }],
      platform: { operator: true, permissions: ['tenants:read'] },
    },
    refresh: async () => undefined,
  }),
}));

vi.mock('../api.js', () => ({
  getReadiness: async () => ({
    status: 'ok',
    checks: { database: { status: 'ok', latencyMs: 4 } },
  }),
  getSystem: async () => ({
    uptimeMs: 60_000,
    database: { ok: true, latencyMs: 4, dialect: 'postgres' },
    counts: {
      users: 3,
      groups: 1,
      domains: 2,
      mailboxes: 4,
      applications: 1,
      auditEvents: 9,
    },
  }),
  listAudit: async () => [
    {
      id: 'evt-1',
      time: '2026-10-02T00:00:00.000Z',
      timestamp: Date.parse('2026-10-02T00:00:00.000Z'),
      action: 'platform.setup.completed',
      outcome: 'success',
      category: 'security',
      actor: { id: '1', type: 'user' },
      resource: { type: 'organisation', id: 'default' },
    },
  ],
}));

describe('DashboardPage', () => {
  it('shows organisation status and directory counts', async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Contoso' })).toBeTruthy();
    expect(screen.getByText(/Owner/)).toBeTruthy();
    expect(screen.getByText(/Platform operator/)).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText(/not running yet/i)).toBeNull();
    expect(screen.queryByText(/Capability map/i)).toBeNull();
    expect(screen.queryByText(/Planned/i)).toBeNull();
  });
});
