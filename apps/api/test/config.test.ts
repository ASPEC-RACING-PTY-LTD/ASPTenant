import { ConfigError } from '@aspec/config';
import { describe, expect, it } from 'vitest';
import { cookieSecure, loadAppConfig } from '../src/config.js';

describe('configuration', () => {
  it('loads the documented development values', () => {
    const config = loadAppConfig({
      ignoreFiles: true,
      processEnv: {
        DATABASE_URL: 'postgres://aspec:aspec@127.0.0.1:5432/aspec',
        PUBLIC_URL: 'http://localhost:8080',
      },
    });
    expect(
      loadAppConfig({ ignoreFiles: true, processEnv: { DATABASE_URL: 'sqlite::memory:' } })
        .publicUrl,
    ).toBeUndefined();
    expect(config.appName).toBe('ASPECTenant');
    expect(config.publicUrl).toBe('http://localhost:8080/');
    expect(cookieSecure(config, null)).toBe(false);
    expect(cookieSecure(config, 'https://mail.example.com')).toBe(true);
    expect(config.databaseUrl.reveal()).toContain('postgres://');
    expect(String(config.databaseUrl)).toBe('[Secret]');
  });

  it('rejects a short audit HMAC key', () => {
    try {
      loadAppConfig({
        ignoreFiles: true,
        processEnv: {
          DATABASE_URL: 'postgres://aspec:aspec@127.0.0.1:5432/aspec',
          PUBLIC_URL: 'http://localhost:8080',
          AUDIT_HMAC_KEY: 'too-short',
        },
      });
      throw new Error('expected configuration to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).details.issues;
      expect(
        issues.some((issue) => issue.path === 'AUDIT_HMAC_KEY' && issue.problem === 'too_short'),
      ).toBe(true);
    }
  });
});
