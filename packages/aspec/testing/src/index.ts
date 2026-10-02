export type { ActAsCredentials } from './act-as.js';
export { actAs } from './act-as.js';
export type {
  CookieAttributes,
  CookieSignatureFormat,
  JwtAlgorithm,
  JwtClaims,
  JwtHeader,
  SessionCookie,
  SessionCookieOptions,
  SignJwtOptions,
  TestJwtSigner,
  TestJwtSignerOptions,
  VerifiedJwt,
  VerifyJwtOptions,
} from './auth.js';
export {
  authHeader,
  createSessionCookie,
  createTestJwtSigner,
  decodeTestJwt,
  signCookieValue,
  signTestJwt,
  unsignCookieValue,
  verifyTestJwt,
} from './auth.js';
export type {
  MockPermissionChecker,
  MockPermissionCheckerOptions,
  PermissionRule,
  PolicyCase,
  RecordedCheck,
  ResourceMatcher,
  SubjectMatcher,
} from './authz.js';
export {
  createMockPermissionChecker,
  expectAllowed,
  expectDenied,
  expectPolicy,
  permissionMatches,
  permissionPatternToRegExp,
} from './authz.js';
export type { CleanupFn } from './cleanup.js';
export { cleanupAll, pendingCleanups, registerCleanup } from './cleanup.js';
export type {
  FastifyLike,
  FetchHandler,
  HonoLike,
  NodeRequestListener,
  TargetKind,
  TestClient,
  TestClientOptions,
  TestResponse,
  TestTarget,
} from './client.js';
export {
  createTestClient,
  detectTargetKind,
  TestRequest,
} from './client.js';
export type { TestClock } from './clock.js';
export { createTestClock, DEFAULT_TEST_TIME } from './clock.js';
export type { StoredCookie } from './cookies.js';
export { CookieJar, parseSetCookie } from './cookies.js';
export type {
  AspecVitestConfig,
  AspecVitestConfigOptions,
  CoverageCheckResult,
  CoverageEntry,
  CoverageMetric,
  CoverageMetricSummary,
  CoverageSummary,
  CoverageSummaryOptions,
  CoverageThresholds,
} from './coverage.js';
export {
  assertCoverage,
  checkCoverage,
  coverageSummary,
  DEFAULT_COVERAGE_EXCLUDE,
  DEFAULT_COVERAGE_INCLUDE,
  DEFAULT_COVERAGE_REPORTERS,
  DEFAULT_COVERAGE_THRESHOLDS,
  defineAspecVitestConfig,
} from './coverage.js';
export type { Mismatch, ValuePredicate } from './diff.js';
export {
  expectPartial,
  formatMismatches,
  formatValue,
  matchesPartial,
  partialMismatches,
  projectToExpected,
} from './diff.js';
export type { EnvIsolation, EnvVars, TempDir, TempDirOptions } from './env.js';
export {
  createTempDir,
  isolateEnv,
  withEnv,
  withTempDir,
} from './env.js';
export type { TestingErrorOptions } from './errors.js';
export { invalidOption, TestingAssertionError, TestingError, TestingErrorCode } from './errors.js';
export type {
  AssociationOptions,
  BuildOptions,
  Factory,
  FactoryContext,
  FactoryOptions,
  MemoryPersistence,
  Overrides,
  PersistenceAdapter,
  Sequence,
  Trait,
} from './factory.js';
export {
  createSequence,
  defineFactory,
  memoryPersistence,
  resetSequences,
} from './factory.js';
export type { FetchFn, MockFetch, MockFetchOptions } from './http-mock.js';
export { mockFetch, toResponse } from './http-mock.js';
export type { FixtureDefinition, FixtureHandle, LifecycleHooks } from './lifecycle.js';
export { useFixture } from './lifecycle.js';
export type { MockServer, MockServerOptions } from './mock-server.js';
export { createMockServer } from './mock-server.js';
export type {
  Clock,
  IdGenerator,
  PermissionChecker,
  ResourceRef,
  SqlClient,
  SqlDialect,
  SqlQueryResult,
  Subject,
} from './ports.js';
export type { Random, RandomOptions } from './random.js';
export {
  createRandom,
  DEFAULT_REFERENCE_DATE,
  getSeed,
  seededRandom,
  setSeed,
} from './random.js';
export type {
  HeaderMatcher,
  MockHandler,
  MockNetworkErrorSpec,
  MockReply,
  MockRequest,
  MockResponseSpec,
  MockRoute,
  QueryMatcher,
  RecordedCall,
  ReplyInit,
  ReplyInput,
  RouteMatcher,
  RouteShortcuts,
} from './routes.js';
export { RouteRegistry, reply, routeShortcuts } from './routes.js';
export type {
  CliJsonResult,
  GenerateKind,
  GenerateOptions,
  InitOptions,
  Language,
  ModuleSystem,
  PackageManager,
  ProjectDetection,
  ScaffoldFile,
  ScaffoldResult,
} from './scaffold.js';
export {
  detectProject,
  runScaffoldCli,
  scaffoldGenerate,
  scaffoldInit,
} from './scaffold.js';
export type {
  ClosableSqlClient,
  MigrateOptions,
  Migration,
  PostgresClientOptions,
  PostgresTestClient,
  SqlFixture,
  SqlFixtureOptions,
  TruncateOptions,
} from './sql.js';
export {
  createPostgresClient,
  createSqlFixture,
  createSqliteClient,
  migrate,
  truncateTables,
  withRollback,
  withTransactionRollback,
} from './sql.js';
export type { FakeTimersApi, FakeTimersHandle } from './timers.js';
export { useFakeTimers, withFakeTimers } from './timers.js';
