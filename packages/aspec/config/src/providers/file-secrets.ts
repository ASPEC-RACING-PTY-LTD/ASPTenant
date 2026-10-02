import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '../errors.js';
import type { SecretProvider } from './types.js';

export interface FileSecretsProviderOptions {
  /** Directory containing secret files named by secret id. */
  directory: string;
  /** Strip a single trailing newline. Default true. */
  stripNewline?: boolean;
}

/** Reads secrets from files in a directory (Kubernetes-style). */
export function createFileSecretsProvider(options: FileSecretsProviderOptions): SecretProvider {
  const strip = options.stripNewline ?? true;
  return {
    name: 'file-secrets',
    async getSecret(id: string): Promise<string> {
      if (id.includes('..') || id.includes('/') || id.includes('\\')) {
        throw new ConfigError('CONFIG_PROVIDER_ERROR', 'secret id must be a plain file name');
      }
      try {
        let text = await readFile(join(options.directory, id), 'utf8');
        if (strip) text = text.replace(/\r?\n$/, '');
        return text;
      } catch (err) {
        throw new ConfigError('CONFIG_PROVIDER_ERROR', `could not read secret file ${id}`, [], {
          cause: err,
        });
      }
    },
  };
}
