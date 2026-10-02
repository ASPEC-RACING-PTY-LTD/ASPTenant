export function createFakeMailer() {
  const sent: Array<{ to: string; subject: string; category?: string; text: string }> = [];
  return {
    sent,
    async send(message: {
      to: string;
      subject: string;
      text: string;
      html?: string;
      category?: string;
    }) {
      const entry: { to: string; subject: string; text: string; category?: string } = {
        to: message.to,
        subject: message.subject,
        text: message.text,
      };
      if (message.category !== undefined) entry.category = message.category;
      sent.push(entry);
      return { id: `mail-${sent.length}` };
    },
  };
}

export function createFakeAudit() {
  const events: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  return {
    events,
    async record(event: { action: string; metadata?: Record<string, unknown> }) {
      const entry: { action: string; metadata?: Record<string, unknown> } = {
        action: event.action,
      };
      if (event.metadata !== undefined) entry.metadata = event.metadata;
      events.push(entry);
      return { id: `audit-${events.length}` };
    },
  };
}

export function createFakePermissions(allow: Set<string> | 'all' = 'all') {
  return {
    async can(_subject: unknown, permission: string) {
      return allow === 'all' || allow.has(permission);
    },
  };
}
