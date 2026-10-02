import { ConfigError } from '../errors.js';
import type { SecretProvider } from './types.js';

/**
 * Structural AWS Secrets Manager client. No AWS SDK dependency; pass any object
 * with `getSecretValue({ SecretId })`.
 */
export interface AwsSecretsManagerClient {
  getSecretValue(input: { SecretId: string }): Promise<{
    SecretString?: string;
    SecretBinary?: Uint8Array;
  }>;
}

export interface AwsSecretsManagerProviderOptions {
  client: AwsSecretsManagerClient;
  /** Optional JSON key when the secret string is a JSON object. Use id `name#key`. */
  cacheTtlMs?: number;
}

export function createAwsSecretsManagerProvider(
  options: AwsSecretsManagerProviderOptions,
): SecretProvider {
  const cache = new Map<string, { value: string; expires: number }>();
  const ttl = options.cacheTtlMs ?? 30_000;
  return {
    name: 'aws-secrets-manager',
    async getSecret(id: string): Promise<string> {
      const cached = cache.get(id);
      if (cached && cached.expires > Date.now()) return cached.value;
      const [secretId, jsonKey] = id.split('#');
      let result: { SecretString?: string; SecretBinary?: Uint8Array };
      try {
        result = await options.client.getSecretValue({ SecretId: secretId as string });
      } catch (err) {
        throw new ConfigError(
          'CONFIG_PROVIDER_ERROR',
          `AWS Secrets Manager read failed for ${secretId}`,
          [],
          {
            cause: err,
          },
        );
      }
      let value = result.SecretString;
      if (value === undefined && result.SecretBinary) {
        value = Buffer.from(result.SecretBinary).toString('utf8');
      }
      if (value === undefined) {
        throw new ConfigError(
          'CONFIG_PROVIDER_ERROR',
          `AWS secret ${secretId} has no string payload`,
        );
      }
      if (jsonKey) {
        try {
          const obj = JSON.parse(value) as Record<string, unknown>;
          const v = obj[jsonKey];
          if (typeof v !== 'string') {
            throw new ConfigError(
              'CONFIG_PROVIDER_ERROR',
              `AWS secret ${secretId} JSON has no string field "${jsonKey}"`,
            );
          }
          value = v;
        } catch (err) {
          if (err instanceof ConfigError) throw err;
          throw new ConfigError('CONFIG_PROVIDER_ERROR', `AWS secret ${secretId} is not JSON`, [], {
            cause: err,
          });
        }
      }
      cache.set(id, { value, expires: Date.now() + ttl });
      return value;
    },
  };
}
