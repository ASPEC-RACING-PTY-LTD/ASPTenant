import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MailPage } from './Mail.js';

vi.mock('../api.js', () => ({
  listMailboxes: async () => [],
  listUsers: async () => [],
  createMailbox: async () => undefined,
  deleteMailbox: async () => undefined,
  addMailboxAlias: async () => undefined,
  removeMailboxAlias: async () => undefined,
}));

describe('MailPage', () => {
  it('states that ASPECTenant owns mailboxes and that delivery is not running', async () => {
    render(<MailPage />);
    expect(screen.getByRole('heading', { name: 'Mail' })).toBeTruthy();
    expect(await screen.findByText(/ASPECTenant owns mailbox data/i)).toBeTruthy();
    expect(screen.getByText(/Cloudflare or another relay is transport/i)).toBeTruthy();
    expect(screen.getByText(/No message store, ingest, IMAP/i)).toBeTruthy();
  });
});
