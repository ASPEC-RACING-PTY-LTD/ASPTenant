/**
 * Mail ownership and transport contracts.
 *
 * ASPECTenant owns mailbox data. Cloudflare, SES, Postmark or a local MTA are
 * transports, not mailbox providers. These types are the stable boundary for
 * later implementation. No provider is implemented in this scaffold.
 *
 * Constraints that shaped the Cloudflare options (official docs, retrieved
 * 2026-10-02):
 * - Email Routing is inbound MX/routing only. It does not store mailboxes.
 * - A Worker `email()` handler must consume, forward or reject the message or
 *   Cloudflare drops it.
 * - Inbound message size is 25 MiB. Routing is capped at 200 rules per domain,
 *   so a catch-all Worker is the intended inbound pattern, not one rule per mailbox.
 * - Email Sending is transactional, currently Beta, and requires the Workers Paid
 *   plan to send to arbitrary recipients. SMTP submission is
 *   smtp.mx.cloudflare.net:465 with implicit TLS only.
 * - Outbound SMTP SIZE is 5 MiB (25 MiB only to verified destination addresses).
 *   Port 25 is reserved for inbound Email Routing, not outbound submission.
 *
 * Sources:
 * https://developers.cloudflare.com/email-service/
 * https://developers.cloudflare.com/email-service/platform/limits/
 * https://developers.cloudflare.com/email-service/api/send-emails/smtp/
 */

export const MAIL_TRANSPORT_KINDS = [
  'cloudflare-email-routing',
  'cloudflare-email-sending',
  'smtp-direct',
  'smtp-relay',
  'ses',
  'postmark',
] as const;

export type MailTransportKind = (typeof MAIL_TRANSPORT_KINDS)[number];

export const MAIL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

export const MAIL_IMPLEMENTATION_STATUS = ['planned', 'available'] as const;
export type MailImplementationStatus = (typeof MAIL_IMPLEMENTATION_STATUS)[number];

/** Raw MIME accepted at the organisation-owned ingest boundary. */
export interface InboundMailMessage {
  envelopeFrom: string;
  envelopeTo: readonly string[];
  raw: Uint8Array;
  receivedAt: number;
  transport: MailTransportKind;
  requestId?: string;
}

export interface InboundAcceptResult {
  accepted: boolean;
  mailboxIds?: readonly string[];
  reason?: string;
}

/**
 * Inbound transport delivers mail into ASPECTenant. The transport must not be
 * treated as the mailbox. Implementations belong in a later mail worker.
 */
export interface InboundMailTransport {
  readonly kind: MailTransportKind;
  readonly direction: 'inbound';
  ingest(message: InboundMailMessage): Promise<InboundAcceptResult>;
}

export interface OutboundMailMessage {
  mailboxId: string;
  envelopeFrom: string;
  envelopeTo: readonly string[];
  raw: Uint8Array;
  messageId?: string;
}

export interface OutboundSubmitResult {
  accepted: boolean;
  providerMessageId?: string;
  retryable?: boolean;
  reason?: string;
}

/** Outbound transport submits mail that already exists in an ASPECTenant mailbox. */
export interface OutboundMailTransport {
  readonly kind: MailTransportKind;
  readonly direction: 'outbound';
  submit(message: OutboundMailMessage): Promise<OutboundSubmitResult>;
}

export interface MailTransportDescriptor {
  kind: MailTransportKind;
  direction: MailDirection;
  status: MailImplementationStatus;
  title: string;
  summary: string;
  constraints: readonly string[];
}

export const MAIL_TRANSPORT_CATALOGUE: readonly MailTransportDescriptor[] = [
  {
    kind: 'cloudflare-email-routing',
    direction: 'inbound',
    status: 'planned',
    title: 'Cloudflare Email Routing',
    summary:
      'Preferred inbound MX when the domain is on Cloudflare. A Worker receives raw MIME and posts it to ASPECTenant ingest. Cloudflare does not keep the mailbox.',
    constraints: [
      'No Cloudflare-hosted mailbox or IMAP store.',
      'Worker email() must consume, forward or reject the message.',
      'Inbound size limit 25 MiB.',
      'At most 200 routing rules per domain; use a catch-all Worker.',
      'Verified forward destinations are capped at 200 per Cloudflare account and are not the ASPECTenant mailbox.',
    ],
  },
  {
    kind: 'cloudflare-email-sending',
    direction: 'outbound',
    status: 'planned',
    title: 'Cloudflare Email Sending',
    summary:
      'Preferred outbound submission when the operator does not want to run a public MTA. SMTP, REST or a Worker binding may be used. Still only a transport.',
    constraints: [
      'Transactional sending; not a marketing or bulk platform.',
      'Workers Paid plan is required to send to arbitrary recipients (docs current as of 2026-10-02).',
      'SMTP is smtp.mx.cloudflare.net:465 implicit TLS only. No port 587 STARTTLS, no unauthenticated port 25 outbound.',
      'Outbound SIZE 5 MiB (25 MiB only to Cloudflare verified destination addresses).',
      'Daily sending limits start conservative and are reputation-based.',
    ],
  },
  {
    kind: 'smtp-direct',
    direction: 'outbound',
    status: 'planned',
    title: 'Direct self-hosted SMTP',
    summary:
      'ASPECTenant submits outbound mail through an operator-owned MTA. Required when Cloudflare or another relay is unavailable or undesired.',
    constraints: [
      'The operator owns IP reputation, PTR, TLS and queueing.',
      'Must remain a replaceable outbound transport, not the mailbox store.',
    ],
  },
  {
    kind: 'smtp-relay',
    direction: 'outbound',
    status: 'planned',
    title: 'Generic SMTP relay',
    summary: 'Authenticated submission to any SMTP smart host, including self-hosted relays.',
    constraints: ['Relay credentials stay in ASPECTenant configuration, not in mailbox data.'],
  },
  {
    kind: 'ses',
    direction: 'outbound',
    status: 'planned',
    title: 'Amazon SES',
    summary: 'Future outbound provider. Same mailbox-ownership rules as other relays.',
    constraints: ['Not implemented. Listed so the transport enum stays stable.'],
  },
  {
    kind: 'postmark',
    direction: 'outbound',
    status: 'planned',
    title: 'Postmark',
    summary: 'Future outbound provider for transactional traffic.',
    constraints: ['Not implemented. Listed so the transport enum stays stable.'],
  },
];

/** Organisation-owned mailbox. Persistence is future work. */
export interface MailboxRecord {
  id: string;
  tenantId: string;
  primaryAddress: string;
  kind: 'user' | 'shared';
  quotaBytes?: number;
}

export interface MailCapabilityStatus {
  implemented: false;
  ownsMailboxes: true;
  inboundTransports: readonly MailTransportKind[];
  outboundTransports: readonly MailTransportKind[];
  notes: readonly string[];
}

export function mailCapabilityStatus(): MailCapabilityStatus {
  return {
    implemented: false,
    ownsMailboxes: true,
    inboundTransports: MAIL_TRANSPORT_CATALOGUE.filter((item) => item.direction === 'inbound').map(
      (item) => item.kind,
    ),
    outboundTransports: MAIL_TRANSPORT_CATALOGUE.filter(
      (item) => item.direction === 'outbound',
    ).map((item) => item.kind),
    notes: [
      'Mailbox directory records and aliases can be provisioned. Folders, messages and attachments are not stored yet.',
      'IMAP and self-hosted webmail are planned against that store, not against Gmail, Microsoft 365 or Cloudflare.',
      'No ingest, SMTP submission, IMAP or webmail server is implemented.',
    ],
  };
}

export function isMailTransportKind(value: string): value is MailTransportKind {
  return (MAIL_TRANSPORT_KINDS as readonly string[]).includes(value);
}
