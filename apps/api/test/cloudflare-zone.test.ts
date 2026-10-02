import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareError, discoverZone, planDnsChallenge } from '../src/dns/index.js';

type Zone = { id: string; name: string };

/** Stubs the Cloudflare zones API. Each token maps to the zones it can see, or an HTTP error. */
function stubCloudflare(
  tokens: Record<string, Zone[] | { status: number; code: number; message: string }>,
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const token = String(((init?.headers ?? {}) as Record<string, string>).authorization).replace(
      'Bearer ',
      '',
    );
    const entry = tokens[token];
    if (!entry || !Array.isArray(entry)) {
      const error = entry ?? { status: 401, code: 10000, message: 'Authentication error' };
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: error.code, message: error.message }] }),
        {
          status: error.status,
        },
      );
    }
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    return new Response(
      JSON.stringify({
        success: true,
        result: page === 1 ? entry : [],
        result_info: { total_pages: 1 },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Cloudflare zone discovery for DNS-01', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the parent zone for mail.aspecracing.com.au and keeps the certificate hostname', async () => {
    stubCloudflare({ good: [{ id: 'z-apex', name: 'aspecracing.com.au' }] });
    const plan = await planDnsChallenge('mail.aspecracing.com.au', [
      { source: 'Domains', token: 'good' },
    ]);
    expect(plan.certificateHostname).toBe('mail.aspecracing.com.au');
    expect(plan.zone).toEqual({ id: 'z-apex', name: 'aspecracing.com.au', subdomain: true });
    expect(plan.recordName).toBe('_acme-challenge.mail.aspecracing.com.au');
  });

  it('picks the longest matching zone when parent and delegated child zones both exist', async () => {
    stubCloudflare({
      good: [
        { id: 'z-apex', name: 'example.com' },
        { id: 'z-child', name: 'eu.example.com' },
        { id: 'z-other', name: 'notexample.com' },
      ],
    });
    expect((await discoverZone('good', 'mail.eu.example.com')).id).toBe('z-child');
    expect((await discoverZone('good', 'mail.example.com')).id).toBe('z-apex');
    expect(await discoverZone('good', 'example.com')).toMatchObject({
      id: 'z-apex',
      subdomain: false,
    });
  });

  it('distinguishes authentication failure, missing Zone:Read and a zone not in the account', async () => {
    stubCloudflare({ empty: [], other: [{ id: 'z', name: 'someoneelse.com' }] });
    await expect(discoverZone('bad', 'mail.aspecracing.com.au')).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringMatching(/authentication failed/),
    });
    await expect(discoverZone('empty', 'mail.aspecracing.com.au')).rejects.toMatchObject({
      kind: 'permission',
      message: expect.stringMatching(/Zone: Read/),
    });
    await expect(discoverZone('other', 'mail.aspecracing.com.au')).rejects.toMatchObject({
      kind: 'not-found',
      message: expect.stringMatching(/someoneelse\.com/),
    });
    const error = await discoverZone('bad', 'x.example.com').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareError);
  });

  it('falls back to the Domains connection when the Mail apps token cannot see the zone', async () => {
    stubCloudflare({ sending: [], domains: [{ id: 'z-apex', name: 'aspecracing.com.au' }] });
    const plan = await planDnsChallenge('mail.aspecracing.com.au', [
      { source: 'Mail apps token', token: 'sending' },
      { source: 'Domains Cloudflare connection', token: 'domains' },
    ]);
    expect(plan.tokenSource).toBe('Domains Cloudflare connection');
    expect(plan.zone.name).toBe('aspecracing.com.au');
    expect(plan.certificateHostname).toBe('mail.aspecracing.com.au');
  });

  it('explains every token failure when none can manage the zone', async () => {
    stubCloudflare({ sending: [] });
    await expect(
      planDnsChallenge('mail.aspecracing.com.au', [
        { source: 'Mail apps token', token: 'sending' },
        { source: 'Domains Cloudflare connection', token: 'revoked' },
      ]),
    ).rejects.toThrow(
      /Mail apps token: .*Zone: Read.*Domains Cloudflare connection: .*authentication failed/,
    );
  });
});
