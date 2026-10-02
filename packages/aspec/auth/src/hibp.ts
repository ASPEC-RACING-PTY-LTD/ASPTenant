import { createHash } from 'node:crypto';

export interface HibpCheckerOptions {
  /**
   * Override the HIBP range API. Default `https://api.pwnedpasswords.com/range/`.
   * Tests inject a local mock; do not point production at an untrusted host.
   */
  rangeUrl?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /**
   * Behaviour when the range API is unreachable. Default `allow` (do not block sign-up on
   * outages). Set to `deny` to reject passwords when the check cannot complete.
   */
  onError?: 'allow' | 'deny';
  /** Optional User-Agent header. HIBP asks callers to identify their application. */
  userAgent?: string;
}

/**
 * Returns a password-compromised checker using the Have I Been Pwned k-anonymity range API.
 * Only the first five characters of the SHA-1 hex digest leave the process.
 */
export function createHibpChecker(
  options: HibpCheckerOptions = {},
): (password: string) => Promise<boolean> {
  const base = `${(options.rangeUrl ?? 'https://api.pwnedpasswords.com/range/').replace(/\/+$/, '')}/`;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const onError = options.onError ?? 'allow';
  const userAgent = options.userAgent ?? 'aspec-auth';

  return async (password: string): Promise<boolean> => {
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${base}${prefix}`, {
        method: 'GET',
        headers: {
          'Add-Padding': 'true',
          'User-Agent': userAgent,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (onError === 'deny') return true;
        return false;
      }
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) {
        const [hashSuffix] = line.split(':');
        if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) return true;
      }
      return false;
    } catch {
      return onError === 'deny';
    } finally {
      clearTimeout(timer);
    }
  };
}
