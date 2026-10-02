export {
  type AuditAdminAction,
  type AuditAdminAuthorizeContext,
  type AuditAdminHandler,
  type AuditAdminOptions,
  type AuditAdminPermissions,
  type AuditAdminResponse,
  type AuditAdminRoute,
  createAuditAdminHandler,
  matchAdminPath,
} from './admin.js';
export {
  canonicalJson,
  digestsEqual,
  hmacSha256Hex,
  sha256Hex,
} from './canonical.js';
export {
  type ChainOptions,
  checkCheckpoint,
  computeEventHash,
  GENESIS_HASH,
  hashParams,
  type KeyInput,
  type ResolvedChainKeys,
  resolveChainKeys,
  sealCheckpoint,
  type VerifyEventsOptions,
  verifyEvents,
} from './chain.js';
export {
  type ActorResolverResult,
  type AuditContext,
  getAuditContext,
  runWithAuditContext,
  setAuditActor,
  updateAuditContext,
} from './context.js';
export {
  buildAuditContext,
  type CorrelationOptions,
  type HeaderGetter,
  normaliseIp,
  parseTraceparent,
  type ResolvedCorrelation,
  resolveClientIp,
  resolveCorrelationOptions,
  type TrustProxy,
} from './correlation.js';

export { computeDiff, type DiffResult, type FieldChange } from './diff.js';
export {
  AUDIT_ERROR_CODES,
  AuditError,
  type AuditErrorCode,
  isAuditError,
} from './errors.js';
export {
  createUuidV7Generator,
  uuidv7,
} from './ids.js';
export {
  type AuditLogger,
  type AuditLoggerOptions,
  createAuditLogger,
  type RetentionOptions,
  type RetentionResult,
} from './logger.js';
export type {
  AuditEventInput,
  AuditSink,
  Clock,
  IdGenerator,
  LoggerLike,
  PermissionChecker,
  ResourceRef,
  SqlClient,
  SqlDialect,
  SqlQueryResult,
  Subject,
} from './ports.js';
export {
  type AuditFilter,
  type AuditQuery,
  type AuditQueryResult,
  compareEvents,
  DEFAULT_QUERY_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_QUERY_LIMIT,
  matchesFilter,
  type NormalisedFilter,
  type NormalisedQuery,
  normaliseFilter,
  normaliseQuery,
} from './query.js';
export {
  type CustomRedactor,
  cleanString,
  createRedactor,
  DEFAULT_SENSITIVE_KEY_FRAGMENTS,
  DEFAULT_SENSITIVE_KEYS_EXACT,
  type KeyPattern,
  REDACTED,
  type RedactionContext,
  type Redactor,
  type RedactorOptions,
  VALUE_DETECTORS,
  type ValueDetector,
  type ValuePattern,
} from './redact.js';
export {
  type BufferedSink,
  type BufferedSinkOptions,
  createBufferedSink,
  type DropReason,
  type OverflowPolicy,
} from './sinks/buffered.js';
export {
  type ConsoleSinkOptions,
  createConsoleSink,
} from './sinks/console.js';
export {
  createFanoutSink,
  type FanoutSinkOptions,
} from './sinks/fanout.js';
export {
  createJsonlFileSink,
  type InvalidJsonlLine,
  type JsonlFileSink,
  type JsonlFileSinkOptions,
  listJsonlFiles,
  readJsonlEvents,
  type VerifyJsonlOptions,
  verifyJsonlLog,
} from './sinks/jsonl.js';
export {
  type AuditEventSink,
  type AuditStore,
  type CheckpointSealer,
  isAuditStore,
  isExpired,
  type PurgeOptions,
  type ReadStreamResult,
  type StoreAttachContext,
  type StreamPurgeResult,
} from './store.js';
export {
  createMemoryAuditStore,
  type MemoryAuditStore,
  type MemoryAuditStoreOptions,
} from './stores/memory.js';
export {
  createSqlAuditStore,
  installAppendOnlyTrigger,
  type Migration,
  migrate,
  migrations,
  migrationsFor,
  type SqlAuditStore,
  type SqlAuditStoreOptions,
} from './stores/sql.js';
export {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  type AuditActor,
  type AuditCategory,
  type AuditChanges,
  type AuditCheckpoint,
  type AuditEvent,
  type AuditOutcome,
  type AuditRecordInput,
  type AuditResource,
  type ChainHead,
  type ChainIssue,
  type ChainIssueKind,
  type ChainVerificationReport,
  type CheckpointKind,
  type HashAlgorithm,
  type VerifyRange,
} from './types.js';
