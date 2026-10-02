import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MailPage } from './Mail.js';

vi.mock('../api.js', () => ({
  listMailboxes: async () => [],
  listUsers: async () => [],
  createMailbox: async () => undefined,
  deleteMailbox: async () => undefined,
  addMailboxAlias: async () => undefined,
  removeMailboxAlias: async () => undefined,
  listMailboxMembers: async () => [],
  addMailboxMember: async () => undefined,
  removeMailboxMember: async () => undefined,
}));

describe('MailPage', () => {
  it('explains that messages are stored in ASPECTenant and links to settings', async () => {
    render(
      <MemoryRouter>
        <MailPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Mail' })).toBeTruthy();
    expect(await screen.findByText(/Messages are stored in/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mail settings' })).toBeTruthy();
  });
});
