import { type DefineConfigOptions, defineConfig, env, type InferConfig } from '@aspec/config';

export const configShape = {
  databaseUrl: env
    .string('DATABASE_URL')
    .secret()
    .description('PostgreSQL URL for the control plane.')
    .example('postgres://aspec:aspec@127.0.0.1:5432/aspec'),
  publicUrl: env
    .url('PUBLIC_URL', { protocols: ['http', 'https'] })
    .description('Public origin of the admin UI.')
    .example('http://localhost:8080'),
  appName: env
    .string('APP_NAME')
    .default('ASPECTenant')
    .description('Product name shown in the UI and audit actor metadata.'),
  logLevel: env
    .enum('LOG_LEVEL', ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)
    .default('info'),
  listenHost: env.string('LISTEN_HOST').default('0.0.0.0'),
  listenPort: env.port('LISTEN_PORT').default(3000),
  trustedProxies: env
    .string('TRUSTED_PROXIES')
    .optional()
    .description('Comma-separated CIDRs or presets trusted for forwarded client IPs.'),
  auditHmacKey: env
    .string('AUDIT_HMAC_KEY', { min: 32 })
    .optional()
    .secret()
    .description('Optional HMAC key for the audit hash chain.'),
  cookieSecure: env
    .boolean('COOKIE_SECURE')
    .optional()
    .description('Force Secure cookies. When unset, derived from PUBLIC_URL.'),
};

export type AppConfig = InferConfig<typeof configShape>;

export function loadAppConfig(options: DefineConfigOptions = {}): AppConfig {
  return defineConfig(configShape, options);
}

export function publicOrigin(config: AppConfig): string {
  return new URL(config.publicUrl).origin;
}

export function cookieSecure(config: AppConfig): boolean {
  if (config.cookieSecure !== undefined) return config.cookieSecure;
  return new URL(config.publicUrl).protocol === 'https:';
}

export function trustedProxyList(config: AppConfig): string[] {
  return (config.trustedProxies ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
