export { migrateDirectory, TENANT_TABLES } from './schema.js';
export {
  DirectoryService,
  type DomainVerificationRecord,
  isUniqueViolation,
  VERIFICATION_LABEL,
  VERIFICATION_PREFIX,
  verificationRecord,
} from './service.js';
export { DirectoryStore } from './store.js';
export type {
  DirectoryApplication,
  DirectoryCounts,
  DirectoryDomain,
  DirectoryGroup,
  DirectoryGroupMember,
  DirectoryMailbox,
  DomainStatus,
  GroupKind,
  MailboxKind,
} from './types.js';
export { DOMAIN_STATUSES, GROUP_KINDS, MAILBOX_KINDS } from './types.js';
