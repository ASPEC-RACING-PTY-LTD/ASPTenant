import { BlockList, isIP } from 'node:net';
import { configError } from './errors.js';

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Normalises an IP address: strips brackets, ports on bracketed IPv6, zone identifiers and
 * converts IPv4-mapped IPv6 to IPv4. Returns undefined for anything that is not an IP.
 */
export function normalizeIp(input: string | undefined | null): string | undefined {
  if (typeof input !== 'string') return undefined;
  let value = input.trim();
  if (value.length === 0 || value.length > 64) return undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return undefined;
    value = value.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  const mapped = MAPPED_V4.exec(value);
  if (mapped?.[1]) value = mapped[1];
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return formatIpv6(parseIpv6(value) ?? []);
  return undefined;
}

export function ipFamily(ip: string): 4 | 6 | 0 {
  const family = isIP(ip);
  return family === 4 || family === 6 ? family : 0;
}

/** Parses an IPv6 address into eight 16-bit groups. */
export function parseIpv6(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let text = address.toLowerCase();
  const tail: number[] = [];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    text = `${text.slice(0, v4.index)}0:0`;
  }
  const halves = text.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  if (tail.length === 2) {
    groups[6] = tail[0] as number;
    groups[7] = tail[1] as number;
  }
  return groups.length === 8 ? groups : undefined;
}

function formatIpv6(groups: readonly number[]): string {
  // Canonical RFC 5952 text: longest run of zero groups (length 2+) compressed.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

/**
 * Groups an IPv6 address by its network prefix (for example /64) so that clients rotating
 * addresses inside one allocation share a bucket. IPv4 addresses are returned unchanged.
 */
export function ipKey(ip: string, ipv6Subnet: number): string {
  if (ipFamily(ip) !== 6 || ipv6Subnet >= 128) return ip;
  const groups = parseIpv6(ip);
  if (!groups) return ip;
  const masked = groups.map((group, index) => {
    const bitsBefore = index * 16;
    if (bitsBefore >= ipv6Subnet) return 0;
    const keep = Math.min(16, ipv6Subnet - bitsBefore);
    return group & ((0xffff << (16 - keep)) & 0xffff);
  });
  return `${formatIpv6(masked)}/${ipv6Subnet}`;
}

const PRESETS: Record<string, readonly string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** Set of IP addresses and CIDR ranges backed by `net.BlockList`. */
export class IpSet {
  readonly #list = new BlockList();
  #size = 0;

  constructor(entries: readonly string[], option: string) {
    for (const raw of entries) this.add(raw, option);
  }

  add(entry: string, option: string): void {
    const preset = PRESETS[entry];
    if (preset) {
      for (const p of preset) this.add(p, option);
      return;
    }
    if (entry === 'private') {
      for (const name of ['loopback', 'linklocal', 'uniquelocal']) this.add(name, option);
      return;
    }
    const slash = entry.indexOf('/');
    const address = normalizeIp(slash === -1 ? entry : entry.slice(0, slash));
    if (!address) throw configError(option, `"${entry}" is not an IP address or CIDR range`);
    const family = ipFamily(address);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (slash === -1) {
      this.#list.addAddress(address, type);
    } else {
      const bits = Number(entry.slice(slash + 1));
      const max = family === 6 ? 128 : 32;
      if (!Number.isInteger(bits) || bits < 0 || bits > max) {
        throw configError(option, `"${entry}" has an invalid prefix length`);
      }
      this.#list.addSubnet(address, bits, type);
    }
    this.#size++;
  }

  has(ip: string | undefined): boolean {
    if (this.#size === 0 || ip === undefined) return false;
    const address = normalizeIp(ip);
    if (!address) return false;
    return this.#list.check(address, ipFamily(address) === 6 ? 'ipv6' : 'ipv4');
  }

  get size(): number {
    return this.#size;
  }
}

export interface AccessListInput {
  /** IP addresses or CIDR ranges ("10.0.0.0/8", "2001:db8::/32"). */
  ips?: readonly string[];
  /** Exact keys, for example "user:42" or "apikey:<hash>". */
  keys?: readonly string[];
}

/** Allowlist or denylist that matches IP addresses (with CIDR) and exact keys. */
export class AccessList {
  readonly #ips: IpSet;
  readonly #keys: ReadonlySet<string>;

  constructor(input: AccessListInput | undefined, option: string) {
    if (input !== undefined && (input === null || typeof input !== 'object')) {
      throw configError(option, 'must be an object with ips and keys arrays');
    }
    const ips = input?.ips ?? [];
    const keys = input?.keys ?? [];
    if (!Array.isArray(ips)) throw configError(`${option}.ips`, 'must be an array');
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
      throw configError(`${option}.keys`, 'must be an array of strings');
    }
    this.#ips = new IpSet(ips, `${option}.ips`);
    this.#keys = new Set(keys);
  }

  get empty(): boolean {
    return this.#ips.size === 0 && this.#keys.size === 0;
  }

  hasIp(ip: string | undefined): boolean {
    return this.#ips.has(ip);
  }

  hasKey(key: string): boolean {
    return this.#keys.has(key);
  }

  /** Matches an exact key, or a key that is itself an IP address inside a listed range. */
  matches(key: string): boolean {
    if (this.#keys.has(key)) return true;
    const ip = key.startsWith('ip:') ? key.slice(3) : key;
    return this.#ips.has(ip);
  }
}
