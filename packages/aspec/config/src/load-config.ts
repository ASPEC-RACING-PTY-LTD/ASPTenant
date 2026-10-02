import {
  type ConfigShape,
  type DefineConfigOptions,
  defineConfig,
  defineConfigWithMeta,
  type InferConfig,
} from './define.js';
import { ConfigError } from './errors.js';
import { EnvField } from './fields.js';
import type { SecretProvider } from './providers/types.js';
import { getSecrets } from './providers/types.js';

export interface LoadConfigOptions<T extends ConfigShape> extends DefineConfigOptions {
  shape: T;
  /**
   * Map of env var name → provider secret id. Values are fetched asynchronously
   * and injected into the environment before defineConfig runs.
   */
  secrets?: Readonly<Record<string, { provider: SecretProvider; id: string }>>;
}

/**
 * Async configuration loader. Fetches external secrets, then validates with defineConfig.
 * `defineConfig` itself stays synchronous.
 */
export async function loadConfig<T extends ConfigShape>(
  options: LoadConfigOptions<T>,
): Promise<InferConfig<T>> {
  const { shape, secrets, ...rest } = options;
  const envOverlay: Record<string, string> = {};
  if (secrets && Object.keys(secrets).length > 0) {
    const byProvider = new Map<SecretProvider, { envName: string; id: string }[]>();
    for (const [envName, ref] of Object.entries(secrets)) {
      const list = byProvider.get(ref.provider) ?? [];
      list.push({ envName, id: ref.id });
      byProvider.set(ref.provider, list);
    }
    for (const [provider, refs] of byProvider) {
      try {
        const values = await getSecrets(
          provider,
          refs.map((r) => r.id),
        );
        for (const ref of refs) {
          const v = values[ref.id];
          if (v === undefined) {
            throw new ConfigError(
              'CONFIG_PROVIDER_ERROR',
              `provider ${provider.name} missing secret ${ref.id}`,
            );
          }
          envOverlay[ref.envName] = v;
        }
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        throw new ConfigError('CONFIG_PROVIDER_ERROR', `provider ${provider.name} failed`, [], {
          cause: err,
        });
      }
    }
  }
  const processEnv = { ...(rest.processEnv ?? process.env), ...envOverlay };
  return defineConfig(shape, { ...rest, processEnv });
}

export { defineConfigWithMeta, EnvField };
