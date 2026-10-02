import { describe, expect, it } from 'vitest';
import {
  isMailTransportKind,
  MAIL_TRANSPORT_CATALOGUE,
  mailCapabilityStatus,
} from '../src/mail/index.js';

describe('mail contracts', () => {
  it('keeps Cloudflare as transport, not a mailbox provider', () => {
    const inbound = MAIL_TRANSPORT_CATALOGUE.find(
      (item) => item.kind === 'cloudflare-email-routing',
    );
    const outbound = MAIL_TRANSPORT_CATALOGUE.find(
      (item) => item.kind === 'cloudflare-email-sending',
    );
    expect(inbound?.status).toBe('planned');
    expect(outbound?.status).toBe('planned');
    expect(
      inbound?.constraints.some(
        (line) => line.includes('does not') || line.includes('No Cloudflare'),
      ),
    ).toBe(true);
    expect(mailCapabilityStatus().ownsMailboxes).toBe(true);
    expect(mailCapabilityStatus().implemented).toBe(false);
  });

  it('rejects unknown transport kinds', () => {
    expect(isMailTransportKind('cloudflare-email-sending')).toBe(true);
    expect(isMailTransportKind('gmail')).toBe(false);
  });
});
