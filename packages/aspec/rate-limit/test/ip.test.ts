import { describe, expect, it } from 'vitest';
import { AccessList, IpSet, ipKey, normalizeIp, parseIpv6 } from '../src/ip.js';
import { createClientIpResolver, parseForwarded } from '../src/proxy.js';

const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name.toLowerCase()];

describe('normalizeIp', () => {
  it('normalises IPv4, IPv6, mapped and bracketed addresses', () => {
    expect(normalizeIp('192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('192.0.2.1:8080')).toBe('192.0.2.1');
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('unknown')).toBeUndefined();
    expect(normalizeIp('')).toBeUndefined();
    expect(normalizeIp(undefined)).toBeUndefined();
    expect(normalizeIp('999.1.1.1')).toBeUndefined();
  });

  it('parses IPv6 with embedded IPv4', () => {
    expect(parseIpv6('64:ff9b::192.0.2.33')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x0221]);
  });
});

describe('IPv6 subnet grouping', () => {
  it('groups addresses in the same /64', () => {
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 64)).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::1', 64)).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:3::1', 64)).toBe('2001:db8:1:3::/64');
    expect(ipKey('2001:db8:1:2:3::1', 56)).toBe('2001:db8:1::/56');
    expect(ipKey('2001:db8::1', 128)).toBe('2001:db8::1');
    expect(ipKey('192.0.2.1', 64)).toBe('192.0.2.1');
  });
});

describe('CIDR matching', () => {
  it('matches IPv4 and IPv6 ranges and presets', () => {
    const set = new IpSet(['10.0.0.0/8', '192.0.2.7', '2001:db8::/32', 'loopback'], 'test');
    expect(set.has('10.200.1.1')).toBe(true);
    expect(set.has('11.0.0.1')).toBe(false);
    expect(set.has('192.0.2.7')).toBe(true);
    expect(set.has('192.0.2.8')).toBe(false);
    expect(set.has('2001:db8:ffff::1')).toBe(true);
    expect(set.has('2001:db9::1')).toBe(false);
    expect(set.has('::ffff:10.1.1.1')).toBe(true);
    expect(set.has('127.0.0.1')).toBe(true);
    expect(set.has('::1')).toBe(true);
    expect(set.has('garbage')).toBe(false);
  });

  it('access lists match keys and IP keys', () => {
    const list = new AccessList({ ips: ['172.16.0.0/12'], keys: ['user:1'] }, 'allowlist');
    expect(list.matches('user:1')).toBe(true);
    expect(list.matches('ip:172.20.0.1')).toBe(true);
    expect(list.matches('172.20.0.1')).toBe(true);
    expect(list.matches('user:2')).toBe(false);
    expect(list.hasIp('172.31.255.255')).toBe(true);
    expect(list.hasIp('172.32.0.0')).toBe(false);
  });
});

describe('trusted proxy parsing', () => {
  it('ignores forwarding headers by default', () => {
    const resolve = createClientIpResolver();
    expect(resolve('10.0.0.1', headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.0.0.1');
  });

  it('ignores headers from untrusted peers (spoofing)', () => {
    const resolve = createClientIpResolver({ trustProxy: ['10.0.0.0/8'] });
    expect(resolve('198.51.100.9', headers({ 'x-forwarded-for': '1.2.3.4' }))).toBe('198.51.100.9');
  });

  it('walks X-Forwarded-For from the right and stops at the first untrusted hop', () => {
    const resolve = createClientIpResolver({ trustProxy: ['10.0.0.0/8'] });
    // Client injected "6.6.6.6"; the real client is 203.0.113.5 appended by our proxy 10.0.0.2.
    const h = headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 10.0.0.2' });
    expect(resolve('10.0.0.1', h)).toBe('203.0.113.5');
  });

  it('uses the leftmost address when every hop is trusted', () => {
    const resolve = createClientIpResolver({ trustProxy: 'private' });
    expect(resolve('10.0.0.1', headers({ 'x-forwarded-for': '192.168.1.5, 10.0.0.2' }))).toBe(
      '192.168.1.5',
    );
  });

  it('supports hop counts', () => {
    const one = createClientIpResolver({ trustProxy: 1 });
    const two = createClientIpResolver({ trustProxy: 2 });
    const h = headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.5, 198.51.100.1' });
    expect(one('10.0.0.1', h)).toBe('198.51.100.1');
    expect(two('10.0.0.1', h)).toBe('203.0.113.5');
  });

  it('stops at unparseable entries instead of trusting them', () => {
    const resolve = createClientIpResolver({ trustProxy: true });
    expect(resolve('10.0.0.1', headers({ 'x-forwarded-for': 'garbage, 203.0.113.5' }))).toBe(
      '203.0.113.5',
    );
  });

  it('parses RFC 7239 Forwarded including quoted IPv6 with ports', () => {
    expect(
      parseForwarded(
        'for=192.0.2.60;proto=http;by=203.0.113.43, for="[2001:db8:cafe::17]:4711", For=unknown',
      ),
    ).toEqual(['192.0.2.60', '[2001:db8:cafe::17]:4711', 'unknown']);
    const resolve = createClientIpResolver({ trustProxy: 'loopback', proxyHeader: 'forwarded' });
    expect(
      resolve('127.0.0.1', headers({ forwarded: 'for=6.6.6.6, for="[2001:db8:cafe::17]:4711"' })),
    ).toBe('2001:db8:cafe::17');
    expect(resolve('127.0.0.1', headers({ forwarded: 'for=unknown' }))).toBe('127.0.0.1');
  });

  it('validates configuration', () => {
    expect(() => createClientIpResolver({ trustProxy: -1 })).toThrow(/trustProxy/);
    expect(() => createClientIpResolver({ trustProxy: ['nope'] })).toThrow(/trustProxy/);
    expect(() => createClientIpResolver({ proxyHeader: 'x-real-ip' as 'forwarded' })).toThrow(
      /proxyHeader/,
    );
  });
});
