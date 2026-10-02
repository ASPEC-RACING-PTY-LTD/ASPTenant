export interface SecretProvider {
  readonly name: string;
  getSecret(id: string): Promise<string>;
  /** Optional bulk read. Default: sequential getSecret. */
  getSecrets?(ids: readonly string[]): Promise<Record<string, string>>;
}

export async function getSecrets(
  provider: SecretProvider,
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (provider.getSecrets) return provider.getSecrets(ids);
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = await provider.getSecret(id);
  return out;
}
