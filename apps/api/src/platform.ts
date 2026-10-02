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
import type { AppConfig } from './config.js';
import { loadAppConfig } from './config.js';
import { DirectoryService, migrateDirectory } from './directory/index.js';
import { platformRbacDefinition } from './permissions.js';

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
  readonly startedAt: number;
}

export interface CreatePlatformOptions {
  config?: AppConfig;
  database?: Database;
  logger?: Logger;
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
    mode: 'single',
    store: createSqlOrgsStore(db),
    audit,
    permissions: rbac,
    logger,
    single: {
      id: 'default',
      name: config.appName,
      slug: 'default',
    },
    invitations: { appName: config.appName },
  });
  await orgs.getDefaultOrg();

  const platform = {
    config,
    db,
    logger,
    auth,
    users,
    orgs,
    rbac,
    audit,
    directory: undefined as unknown as DirectoryService,
    startedAt: Date.now(),
  };
  platform.directory = new DirectoryService(platform);
  return platform;
}

export async function closePlatform(platform: Platform): Promise<void> {
  await platform.auth.idle();
  await platform.db.close();
}
