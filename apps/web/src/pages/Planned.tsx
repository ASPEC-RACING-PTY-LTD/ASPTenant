const COPY: Record<string, { title: string; body: string }> = {
  migration: {
    title: 'Migration',
    body: 'Mailbox migration from Microsoft 365, Google Workspace and generic IMAP is planned against ASPECTenant-owned storage. No migration jobs are stored or executed yet.',
  },
};

export function PlannedPage({ area }: { area: keyof typeof COPY }) {
  const page = COPY[area];
  if (!page) throw new Error(`Unknown planned area: ${area}`);
  return (
    <>
      <div className="page-header">
        <h1>{page.title}</h1>
        <p>This area is part of the long-term product. It is not available yet.</p>
      </div>
      <section className="panel">
        <h2>Status</h2>
        <p>
          <span className="badge badge-off">Planned</span>
        </p>
        <p>{page.body}</p>
      </section>
    </>
  );
}
