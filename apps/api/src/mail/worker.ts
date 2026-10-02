const TEMPLATE = `// ASPECTenant inbound mail Worker for Cloudflare Email Routing.
// Set the secret INGEST_TOKEN in Worker > Settings > Variables and Secrets.
const INGEST_URL = '__INGEST_URL__';

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const response = await fetch(env.INGEST_URL || INGEST_URL, {
      method: 'POST',
      headers: {
        authorization: \`Bearer \${env.INGEST_TOKEN}\`,
        'content-type': 'message/rfc822',
        'x-envelope-from': message.from,
        'x-envelope-to': message.to,
      },
      body: raw,
    });
    if (response.status === 404) {
      message.setReject('550 5.1.1 No such recipient');
      return;
    }
    if (response.status === 413) {
      message.setReject('552 5.3.4 Message too large');
      return;
    }
    if (!response.ok) {
      throw new Error(\`ASPECTenant ingest returned \${response.status}\`);
    }
  },
};
`;

/** Worker source shown on Mail settings, with this server's ingest URL filled in. */
export function cloudflareWorkerScript(ingestUrl: string): string {
  return TEMPLATE.replace('__INGEST_URL__', ingestUrl.replace(/'/g, ''));
}
