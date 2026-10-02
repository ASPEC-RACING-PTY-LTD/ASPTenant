import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';

/**
 * Encrypts credentials stored in the database (SMTP passwords, API tokens).
 * The key is derived from SECRET_KEY, else AUDIT_HMAC_KEY, else DATABASE_URL,
 * so a normal install needs no extra environment variable.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(config: AppConfig) {
    const material =
      config.secretKey?.reveal() ?? config.auditHmacKey?.reveal() ?? config.databaseUrl.reveal();
    this.key = Buffer.from(hkdfSync('sha256', material, 'aspectenant', 'settings-encryption', 32));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`;
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }

  /** Stable, non-reversible token for a purpose (for example domain verification). */
  derive(purpose: string): string {
    return createHmac('sha256', this.key).update(purpose).digest('hex').slice(0, 32);
  }
}
