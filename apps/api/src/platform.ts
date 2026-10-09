import { randomBytes } from 'node:crypto';
import type { MxRecord } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { createAuditLogger } from '@aspec/audit';
import { createSqlAuditStore, migrate as migrateAudit } from '@aspec/audit/sql';
import { type Auth, createAuth } from '@aspec/auth';
import { createSqlAuthStore, migrate as migrateAuth } from '@aspec/auth/sql';
import { createDatabase, type Database } from '@aspec/db';
import { createLogger, type Logger } from '@aspec/observability';
import { createOrgs, type OrgsService } from '@aspec/orgs';
import { createSqlOrgsStore, migrate as migrateOrgs } from '@aspec/orgs/sql';
import { createRbac, type Rbac } from '@aspec/rbac';
import { createSqlStore as createSqlRbacStore, migrate as migrateRbac } from '@aspec/rbac/sql';
import { createUsers, type UsersService } from '@aspec/users';
import { createSqlUsersStore, migrate as migrateUsers } from '@aspec/users/sql';
import { BackupService } from './backup/index.js';
import type { AppConfig } from './config.js';
import { loadAppConfig } from './config.js';
import { DirectoryService, migrateDirectory, PLATFORM_SCOPE } from './directory/index.js';
import { DomainConnect } from './dns/domainconnect.js';
import { DomainSetup } from './dns/index.js';
import { PstImporter } from './imports/pst.js';
import { MailService } from './mail/service.js';
import { SettingsStore } from './mail/store.js';
import { MailServers } from './mailserver/index.js';
import { platformRbacDefinition } from './permissions.js';
import { SecretBox } from './secrets.js';
import { inScope, reconcileLegacyRoleAssignments, rowLevelSecurityStatus } from './tenancy.js';
import { UpdateService } from './updates.js';

/** DNS lookups used for domain verification and checks. */
export interface DnsLookup {
  /** TXT records, each as its character-string chunks. */
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<MxRecord[]>;
}

function publicDns(): DnsLookup {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolveMx: (name) => resolver.resolveMx(name),
  };
}

export interface Platform {
  readonly config: AppConfig;
  readonly db: Database;
  readonly logger: Logger;
  readonly auth: Auth;
  readonly users: UsersService;
  readonly orgs: OrgsService;
  readonly rbac: Rbac;
  readonly audit: ReturnType<typeof createAuditLogger>;
  readonly directory: DirectoryService;
  readonly mail: MailService;
  readonly updates: UpdateService;
  readonly mailServers: MailServers;
  readonly imports: PstImporter;
  readonly backups: BackupService;
  readonly domainSetup: DomainSetup;
  readonly domainConnect: DomainConnect;
  readonly secrets: SecretBox;
  readonly dns: DnsLookup;
  /** Public origin from Settings (or PUBLIC_URL). Changing it restarts the API. */
  publicUrl: string | null;
  /** Restart after settings that are read at boot change. Disabled in tests. */
  restart: () => void;
  /** One-time code printed to the log while first-run setup is open. */
  setupCode: string | null;
  readonly startedAt: number;
}

export interface CreatePlatformOptions {
  config?: AppConfig;
  database?: Database;
  logger?: Logger;
  /** DNS used for domain verification. Defaults to public resolvers. */
  dns?: DnsLookup;
}

export async function createPlatform(options: CreatePlatformOptions = {}): Promise<Platform> {
  const config = options.config ?? loadAppConfig();
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      pretty: process.env.NODE_ENV !== 'production',
      bindings: { service: 'aspectenant-api' },
    });
  const databaseUrl = config.databaseUrl.reveal();
  const db =
    options.database ??
    (await createDatabase({
      url: databaseUrl,
      ...(databaseUrl.startsWith('postgres') ? { applicationName: 'aspectenant' } : {}),
    }));

  await migrateAuth(db);
  await migrateUsers(db);
  await migrateOrgs(db);
  await migrateRbac(db);
  await migrateAudit(db);
  await migrateDirectory(db);

  const auditKey = config.auditHmacKey?.reveal();
  const audit = createAuditLogger({
    sink: createSqlAuditStore(db),
    logger,
    ...(auditKey ? { chain: { hmacKey: auditKey } } : {}),
  });

  const auth = createAuth({
    store: createSqlAuthStore(db),
    audit,
    logger,
    appName: config.appName,
    passwordPolicy: { minLength: 12 },
  });

  const rbac = createRbac({
    store: createSqlRbacStore(db),
    definition: platformRbacDefinition,
    audit,
    logger,
  });
  await rbac.init();

  const users = createUsers({
    store: createSqlUsersStore(db),
    audit,
    permissions: rbac,
    logger,
  });

  const orgs = createOrgs({
    mode: 'multi',
    store: createSqlOrgsStore(db),
    audit,
    permissions: rbac,
    logger,
    invitations: { appName: config.appName },
  });

  const platform: Platform = {
    config,
    db,
    logger,
    auth,
    users,
    orgs,
    rbac,
    audit,
    directory: undefined as unknown as DirectoryService,
    mail: undefined as unknown as MailService,
    updates: undefined as unknown as UpdateService,
    mailServers: undefined as unknown as MailServers,
    imports: undefined as unknown as PstImporter,
    backups: undefined as unknown as BackupService,
    domainSetup: undefined as unknown as DomainSetup,
    domainConnect: undefined as unknown as DomainConnect,
    secrets: new SecretBox(config),
    dns: options.dns ?? publicDns(),
    publicUrl: config.publicUrl ? new URL(config.publicUrl).origin : null,
    restart: () => {
      setTimeout(() => process.exit(0), 1500).unref();
    },
    setupCode: null,
    startedAt: Date.now(),
  };
  Object.assign(platform, {
    directory: new DirectoryService(platform),
    mail: new MailService(platform),
    updates: new UpdateService(platform),
    mailServers: new MailServers(platform),
    imports: new PstImporter(platform),
    backups: new BackupService(platform),
    domainSetup: new DomainSetup(platform),
    domainConnect: new DomainConnect(platform),
  });
  await reconcileLegacyRoleAssignments(platform);
  if (db.dialect === 'postgres') {
    const rls = await rowLevelSecurityStatus(db);
    if (!rls.enforced) logger.warn({ rls }, rls.detail);
  }
  const general = await inScope(platform, PLATFORM_SCOPE, () =>
    new SettingsStore(db).get<{ publicUrl?: string }>(PLATFORM_SCOPE, 'general'),
  );
  if (general?.publicUrl) platform.publicUrl = general.publicUrl;
  const firstUser = await users.listUsers({ limit: 1 });
  if (firstUser.items.length === 0) {
    const code = randomBytes(5).toString('hex').toUpperCase();
    platform.setupCode = `${code.slice(0, 5)}-${code.slice(5)}`;
    logger.warn(
      `Setup code: ${platform.setupCode} (enter it on /setup to create the administrator)`,
    );
  }
  return platform;
}

export async function closePlatform(platform: Platform): Promise<void> {
  platform.updates.stop();
  platform.mailServers.shutdown();
  platform.imports.stop();
  platform.backups.stop();
  await platform.auth.idle();
  await platform.db.close();
}
