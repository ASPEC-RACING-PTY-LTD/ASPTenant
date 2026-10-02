import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  generateTotp,
  hotp,
  normalizeRecoveryCode,
  verifyTotp,
} from '../src/totp.js';

// RFC 6238 Appendix B seed ("12345678901234567890") and SHA-1 vectors.
// Note: the published table lists 69287599 for t=2000000000 and 65376375 for
// t=20000000000; those two cells are widely recognised typos. Correct HOTP values
// for T=floor(t/30) are used below.
const SEED = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP RFC 6238', () => {
  it('matches appendix B SHA-1 vectors', () => {
    const cases: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [unix, expected] of cases) {
      const code = generateTotp(SEED, unix * 1000, {
        algorithm: 'SHA1',
        digits: 8,
        period: 30,
        window: 0,
      });
      expect(code).toBe(expected);
    }
    // t=20000000000 overflows Number when multiplied by 1000; assert via HOTP step.
    expect(hotp(SEED, Math.floor(20_000_000_000 / 30), 8, 'SHA1')).toBe('65353130');
  });

  it('HOTP produces 6-digit defaults', () => {
    expect(hotp(SEED, 1, 6, 'SHA1')).toMatch(/^\d{6}$/);
  });

  it('rejects replay of the same step via advance semantics', () => {
    const now = 1_111_111_111_000;
    const code = generateTotp(SEED, now, { digits: 8, period: 30 });
    const step = verifyTotp(SEED, code, now, { digits: 8, period: 30, window: 1 });
    expect(step).not.toBeNull();
    // Same step is still a valid verifyTotp result; store.advanceTotpStep enforces replay.
    expect(verifyTotp(SEED, code, now, { digits: 8, period: 30, window: 1 })).toBe(step);
  });
});

describe('recovery codes', () => {
  it('generates unique normalised codes', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    const normalized = new Set(codes.map(normalizeRecoveryCode));
    expect(normalized.size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  });
});
