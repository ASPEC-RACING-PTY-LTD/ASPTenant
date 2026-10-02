import { type DefineConfigOptions, defineConfig, env, type InferConfig } from '@aspec/config';

export const configShape = {
  databaseUrl: env
    .string('DATABASE_URL')
    .secret()
    .description('PostgreSQL URL for the control plane.')
    .example('postgres://aspec:aspec@127.0.0.1:5432/aspec'),
  publicUrl: env
    .url('PUBLIC_URL', { protocols: ['http', 'https'] })
    .optional()
    .description('Optional. Public origin of the admin UI; normally set on the Settings page.'),
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
  appVersion: env
    .string('APP_VERSION')
    .default('dev')
    .description('Release version baked into published images.'),
  updateRepo: env
    .string('UPDATE_REPO')
    .default('ASPEC-RACING-PTY-LTD/ASPTenant')
    .description('GitHub repository checked for new releases.'),
  updatesDir: env
    .string('UPDATES_DIR')
    .default('/updates')
    .description('Directory shared with the updater sidecar.'),
  dataDir: env
    .string('DATA_DIR')
    .default('/data')
    .description('Writable directory for uploads and backup staging.'),
  secretKey: env
    .string('SECRET_KEY', { min: 32 })
    .optional()
    .secret()
    .description('Key for encrypting stored credentials. Defaults to AUDIT_HMAC_KEY.'),
  cookieSecure: env
    .boolean('COOKIE_SECURE')
    .optional()
    .description('Force Secure cookies. When unset, derived from PUBLIC_URL.'),
};

export type AppConfig = InferConfig<typeof configShape>;

export function loadAppConfig(options: DefineConfigOptions = {}): AppConfig {
  return defineConfig(configShape, options);
}

export function cookieSecure(config: AppConfig, publicUrl: string | null): boolean {
  if (config.cookieSecure !== undefined) return config.cookieSecure;
  return publicUrl ? new URL(publicUrl).protocol === 'https:' : false;
}

export function trustedProxyList(config: AppConfig): string[] {
  return (config.trustedProxies ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
