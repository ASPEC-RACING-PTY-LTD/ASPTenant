import { createVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './helpers.js';

describe('Domain Connect', () => {
  let ctx: TestContext;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (ctx) await destroyTestContext(ctx);
  });

  it('builds a signed apply URL at the discovered provider, with sig last', async () => {
    ctx = await createTestContext();
    const dc = ctx.platform.domainConnect;
    const view = await dc.update({
      providerId: 'aspecracing.com.au',
      serviceId: 'aspectenant-mail',
      keyId: '_dck1',
      generateKey: true,
    });
    expect(view.configured).toBe(true);
    expect(view.publicKeyTxt).toMatch(/^p=1,a=RS256,d=/);
    dc.txt = async (name) =>
      name === '_domainconnect.example.com'
        ? ['api.cloudflare.com/client/v4/dns/domainconnect']
        : [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/v2/example.com/settings')) {
          return new Response(
            JSON.stringify({
              providerName: 'Cloudflare',
              urlSyncUX: 'https://dash.cloudflare.com/domainconnect',
              urlAPI: 'https://api.cloudflare.com/client/v4/dns/domainconnect',
            }),
          );
        }
        if (url.includes('/providers/aspecracing.com.au/services/aspectenant-mail'))
          return new Response('{}');
        return new Response('', { status: 404 });
      }),
    );
    const result = await dc.applyUrl(
      'example.com',
      { verification: 'aspectenant-verification=abc' },
      'https://panel.test/domain-connect/done',
    );
    if (!result.supported) throw new Error(result.reason);
    const url = new URL(result.applyUrl);
    expect(url.origin + url.pathname).toBe(
      'https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/aspecracing.com.au/services/aspectenant-mail/apply',
    );
    expect([...url.searchParams.keys()].at(-1)).toBe('sig');
    expect(url.searchParams.get('verification')).toBe('aspectenant-verification=abc');
    const signed = result.applyUrl.split('?')[1]?.split('&key=')[0] ?? '';
    const ok = createVerify('RSA-SHA256')
      .update(signed)
      .verify(view.publicKey ?? '', url.searchParams.get('sig') ?? '', 'base64');
    expect(ok).toBe(true);
  });

  it('falls back when unconfigured, unsupported or not onboarded', async () => {
    ctx = await createTestContext();
    const dc = ctx.platform.domainConnect;
    expect(await dc.applyUrl('example.com', {}, 'https://x/done')).toMatchObject({
      supported: false,
    });
    await dc.update({ providerId: 'p.example', serviceId: 's', keyId: '_dck1', generateKey: true });
    dc.txt = async () => [];
    expect(await dc.applyUrl('example.com', {}, 'https://x/done')).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/does not support Domain Connect/),
    });
    dc.txt = async () => ['dc.example'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/settings')
          ? new Response(
              JSON.stringify({
                providerName: 'GoDaddy',
                urlSyncUX: 'https://ux',
                urlAPI: 'https://api',
              }),
            )
          : new Response('', { status: 404 }),
      ),
    );
    expect(await dc.applyUrl('example.com', {}, 'https://x/done')).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/GoDaddy .*not onboarded/),
    });
  });
});
