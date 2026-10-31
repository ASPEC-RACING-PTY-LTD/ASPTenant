import { describe, expect, it } from 'vitest';
import { recoveryCodesFileName, recoveryCodesText } from './recoveryCodes.js';

describe('recovery codes file', () => {
  it('is named after the initials and the subdomain', () => {
    expect(recoveryCodesFileName('Ali Saied', 'a@x.test', 'apt.aspecracing.com.au')).toBe(
      'as-apt-recovery-codes.txt',
    );
    expect(recoveryCodesFileName('Mary Jane Watson', 'm@x.test', 'mail.example.com')).toBe(
      'mw-mail-recovery-codes.txt',
    );
    expect(recoveryCodesFileName(null, 'olivia.owner@x.test', 'localhost')).toBe(
      'oo-localhost-recovery-codes.txt',
    );
    expect(recoveryCodesFileName('  ', 'ops@x.test', 'apt.example.com')).toBe(
      'o-apt-recovery-codes.txt',
    );
  });

  it('lists every code under a short explanation', () => {
    const text = recoveryCodesText(['AAAA-1111', 'BBBB-2222'], 'a@x.test', 'apt.example.com');
    expect(text).toContain('Recovery codes for a@x.test on apt.example.com');
    expect(text.split('\r\n')).toEqual(expect.arrayContaining(['AAAA-1111', 'BBBB-2222']));
  });
});
