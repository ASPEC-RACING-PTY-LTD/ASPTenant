// ASPECTenant inbound mail Worker for Cloudflare Email Routing.
//
// Cloudflare receives mail for your domain (MX records) and runs this Worker for
// each recipient. The Worker forwards the raw message to your ASPECTenant server,
// which stores it in the mailbox. Cloudflare does not keep a copy.
//
// Variables (Worker > Settings > Variables and Secrets):
//   INGEST_URL    https://<your ASPECTenant host>/api/v1/mail/ingest
//   INGEST_TOKEN  secret generated on Mail settings in ASPECTenant
//
// Then in Email Routing > Routing rules, set the catch-all action to "Send to a Worker".

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const response = await fetch(env.INGEST_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.INGEST_TOKEN}`,
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
      // Throwing makes Cloudflare report a delivery failure instead of silently dropping mail.
      throw new Error(`ASPECTenant ingest returned ${response.status}`);
    }
  },
};
