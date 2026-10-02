import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '../src/fields.js';
import { loadConfig } from '../src/load-config.js';
import { createAwsSecretsManagerProvider } from '../src/providers/aws.js';
import { createFileSecretsProvider } from '../src/providers/file-secrets.js';
import { createVaultKvV2Provider } from '../src/providers/vault.js';

describe('providers', () => {
  it('reads Vault KV v2 via in-process mock', async () => {
    const provider = createVaultKvV2Provider({
      address: 'https://vault.test',
      token: 't',
      fetch: async (input) => {
        const url = String(input);
        expect(url).toContain('/v1/secret/data/app/db');
        return new Response(
          JSON.stringify({ data: { data: { value: 'vault-secret', password: 'p' } } }),
          { status: 200 },
        );
      },
    });
    expect(await provider.getSecret('app/db')).toBe('vault-secret');
    expect(await provider.getSecret('app/db#password')).toBe('p');
  });

  it('reads AWS Secrets Manager via structural client', async () => {
    const provider = createAwsSecretsManagerProvider({
      client: {
        async getSecretValue({ SecretId }) {
          if (SecretId === 'prod/db')
            return { SecretString: JSON.stringify({ url: 'postgres://aws' }) };
          return { SecretString: 'plain' };
        },
      },
    });
    expect(await provider.getSecret('prod/db#url')).toBe('postgres://aws');
    expect(await provider.getSecret('plain')).toBe('plain');
  });

  it('reads file secrets directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-secrets-'));
    try {
      await writeFile(join(dir, 'db'), 'from-file\n');
      const provider = createFileSecretsProvider({ directory: dir });
      expect(await provider.getSecret('db')).toBe('from-file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig injects provider secrets before validation', async () => {
    const provider = createVaultKvV2Provider({
      address: 'https://vault.test',
      token: 't',
      fetch: async () =>
        new Response(JSON.stringify({ data: { data: { value: 'postgres://vault/db' } } }), {
          status: 200,
        }),
    });
    const config = await loadConfig({
      shape: { databaseUrl: env.url('DATABASE_URL').secret() },
      ignoreFiles: true,
      processEnv: {},
      secrets: { DATABASE_URL: { provider, id: 'app/db' } },
    });
    expect(config.databaseUrl.reveal()).toBe('postgres://vault/db');
  });
});
