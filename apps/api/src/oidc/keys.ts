import { generateKeyPairSync, type JsonWebKey, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@aspec/db';
import { PLATFORM_SCOPE } from '../directory/schema.js';
import { SettingsStore } from '../mail/store.js';
import type { SecretBox } from '../secrets.js';
import { inScope } from '../tenancy.js';

const KEY = 'identity-keys';
/** Signing keys kept in the JWKS after rotation, newest first, so issued tokens still verify. */
const KEEP_SIGNING_KEYS = 3;

interface StoredKeys {
  /** AES-256-GCM key for TOTP secrets, encrypted with the settings key. */
  mfaKey: string;
  /** Keys that sign the provider's cookies, encrypted. */
  cookieKeys: string[];
  /** RSA signing keys (private JWK JSON, encrypted), newest first. The first one signs. */
  signing: Array<{ kid: string; createdAt: number; jwk: string }>;
}

export interface SigningKeyInfo {
  kid: string;
  createdAt: number;
  active: boolean;
}

export interface IdentityKeys {
  mfaKey: Buffer;
  cookieKeys: string[];
  /** Private signing JWKs, newest (active) first. */
  signing: JsonWebKey[];
  info: SigningKeyInfo[];
}

function newSigningKey(): { kid: string; createdAt: number; jwk: JsonWebKey } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  return {
    kid,
    createdAt: Date.now(),
    jwk: { ...privateKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
}

/**
 * Keys for sign-in: generated on first start and kept in installation settings, encrypted with
 * the settings key, so they move with backups and survive restarts.
 */
export class IdentityKeyStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;

  constructor(db: Database, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  private store(): SettingsStore {
    return new SettingsStore(this.db);
  }

  private async read(): Promise<StoredKeys | null> {
    return inScope({ db: this.db }, PLATFORM_SCOPE, () =>
      this.store().get<StoredKeys>(PLATFORM_SCOPE, KEY),
    );
  }

  private async write(keys: StoredKeys): Promise<void> {
    await inScope({ db: this.db }, PLATFORM_SCOPE, () =>
      this.store().set(PLATFORM_SCOPE, KEY, keys),
    );
  }

  /** Loads the keys, creating any that are missing. */
  async load(): Promise<IdentityKeys> {
    let stored = await this.read();
    if (!stored?.mfaKey || !stored.cookieKeys?.length || !stored.signing?.length) {
      const key = newSigningKey();
      stored = {
        mfaKey: stored?.mfaKey ?? this.secrets.encrypt(randomBytes(32).toString('base64')),
        cookieKeys: stored?.cookieKeys?.length
          ? stored.cookieKeys
          : [this.secrets.encrypt(randomBytes(32).toString('base64url'))],
        signing: stored?.signing?.length
          ? stored.signing
          : [
              {
                kid: key.kid,
                createdAt: key.createdAt,
                jwk: this.secrets.encrypt(JSON.stringify(key.jwk)),
              },
            ],
      };
      await this.write(stored);
    }
    return this.open(stored);
  }

  private open(stored: StoredKeys): IdentityKeys {
    return {
      mfaKey: Buffer.from(this.secrets.decrypt(stored.mfaKey), 'base64'),
      cookieKeys: stored.cookieKeys.map((item) => this.secrets.decrypt(item)),
      signing: stored.signing.map(
        (item) => JSON.parse(this.secrets.decrypt(item.jwk)) as JsonWebKey,
      ),
      info: stored.signing.map((item, index) => ({
        kid: item.kid,
        createdAt: item.createdAt,
        active: index === 0,
      })),
    };
  }

  /**
   * Adds a new signing key that signs from now on. The previous keys stay published until
   * they drop out of the kept window, so tokens they signed still verify.
   */
  async rotateSigningKey(): Promise<IdentityKeys> {
    const current = (await this.read()) ?? null;
    if (!current) return this.load();
    const key = newSigningKey();
    const next: StoredKeys = {
      ...current,
      signing: [
        {
          kid: key.kid,
          createdAt: key.createdAt,
          jwk: this.secrets.encrypt(JSON.stringify(key.jwk)),
        },
        ...current.signing,
      ].slice(0, KEEP_SIGNING_KEYS),
    };
    await this.write(next);
    return this.open(next);
  }
}
