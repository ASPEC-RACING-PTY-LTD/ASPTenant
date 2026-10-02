export type {
  AssignRoleInput,
  CreatePermissionInput,
  CreateRoleInput,
  GrantInput,
  ListFilter,
  OwnershipRuleInput,
  PolicyInput,
  RbacAdmin,
  RevokeRoleInput,
  UpdateOwnershipRuleInput,
  UpdatePermissionInput,
  UpdatePolicyInput,
  UpdateRoleInput,
} from './admin.js';
export { createAdmin } from './admin.js';
export type {
  AdminCallOptions,
  Auditor,
  RbacAuditAction,
} from './audit.js';
export { actorOf, createAuditor, RBAC_AUDIT_ACTIONS } from './audit.js';
export type {
  ConditionInput,
  PolicyCondition,
} from './conditions.js';
export {
  compileCondition,
  conditionIssues,
  conditionUsesTime,
  evaluateCondition,
  validateCondition,
} from './conditions.js';

export type {
  LoadedRbacConfig,
  NormalisedOwnershipDefinition,
  NormalisedPolicyDefinition,
  NormalisedRoleDefinition,
  OwnershipDefinition,
  PermissionDefinition,
  PolicyDefinition,
  RbacConfigOptions,
  RbacDefinition,
  RbacDefinitionInput,
  RoleDefinition,
  SeedOptions,
  SeedResult,
} from './config.js';
export {
  DEFAULT_ADMIN_PERMISSION,
  defineRbac,
  isRbacDefinition,
  isValidTimeZone,
  loadRbacConfig,
  patternIsRegistered,
  readPolicyInput,
  seedDefinition,
} from './config.js';
export type {
  AppliedRole,
  BatchCheck,
  CheckContext,
  DecisionReason,
  EffectivePermissions,
  EngineInternals,
  PolicyEvaluation,
  Rbac,
  RbacDecision,
  RbacExplanation,
  RbacLimits,
  RbacOptions,
  SnapshotOptions,
  TraceEntry,
} from './engine.js';
export { createRbac } from './engine.js';

export type {
  RbacErrorCode,
  RbacErrorOptions,
  RbacNotFoundCode,
  RbacValidationIssue,
} from './errors.js';
export {
  isRbacError,
  RbacConfigError,
  RbacConflictError,
  RbacCycleDetectedError,
  RbacError,
  RbacEscalationError,
  RbacForbiddenError,
  RbacImmutableError,
  RbacInUseError,
  RbacInvalidPermissionError,
  RbacInvalidPolicyError,
  RbacLimitError,
  RbacNotFoundError,
  RbacRoleNotFoundError,
  RbacUnauthenticatedError,
  RbacValidationError,
} from './errors.js';

export { createUuidV7Generator } from './ids.js';

export type { ParsedPermission, PermissionSet } from './permissions.js';
export {
  createPermissionSet,
  EMPTY_PERMISSION_SET,
  isValidPermission,
  isWildcardPermission,
  MAX_PERMISSION_LENGTH,
  normalisePermission,
  parsePermission,
  permissionCovers,
  permissionProblem,
  permissionsOverlap,
} from './permissions.js';

export type {
  AuditEventInput,
  AuditSink,
  CacheLike,
  Clock,
  ErrorLike,
  IdGenerator,
  LoggerLike,
  PermissionChecker,
  ResourceRef,
  SqlClient,
  SqlDialect,
  SqlQueryResult,
  Subject,
} from './ports.js';

export type {
  PermissionSnapshot,
  SnapshotEvaluator,
  SnapshotGrant,
  SnapshotResourceDecision,
} from './snapshot.js';
export { createSnapshotEvaluator, parsePermissionSnapshot } from './snapshot.js';

export type {
  AssignmentFilter,
  GrantFilter,
  GrantLookup,
  PrincipalGrantLookup,
  RbacStore,
  StorePage,
} from './store.js';

export type {
  ClaimsMapping,
  SubjectResolver,
  UserMapping,
} from './subject.js';
export { subjectFromClaims, subjectFromUser } from './subject.js';

export type {
  AssignmentRecord,
  Effect,
  GrantRecord,
  OwnershipRuleRecord,
  Page,
  PageRequest,
  PermissionRecord,
  PolicyRecord,
  RbacScope,
  RoleRecord,
  ScopeKind,
} from './types.js';
export { SCOPE_KINDS } from './types.js';

export {
  checkUnknownKeys,
  Issues,
  isIdentifier,
  isRecord,
  MAX_DESCRIPTION_LENGTH,
  MAX_ID_LENGTH,
  MAX_NAME_LENGTH,
  makeScope,
  normaliseScope,
  RECORD_ID,
  RESOURCE_TYPE,
  ROLE_KEY,
  readIdentifier,
  readKeyList,
  readLimit,
  readPattern,
  readPermissionList,
  readScope,
  readScopeKinds,
  readText,
  readTimestamp,
  scopeKind,
} from './validate.js';
