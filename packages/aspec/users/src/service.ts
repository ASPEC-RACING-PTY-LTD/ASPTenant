import {
  issueToken,
  parseToken,
  sha256Hex,
  TOKEN_RECORD_ID,
  uuidv7,
  verifyTokenHash,
} from './crypto.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { UsersError, type ValidationIssue, validationError } from './errors.js';
import {
  applyFieldPatch,
  assertFieldDefinitions,
  checkRequired,
  type FieldDefinitions,
  mergeWithDefaults,
} from './fields.js';
import type {
  AuditEventInput,
  AuditSink,
  Clock,
  IdGenerator,
  JobQueue,
  LoggerLike,
  Mailer,
  PermissionChecker,
  ResourceRef,
  Subject,
} from './ports.js';
import type { UsersStore } from './store.js';
import type {
  ActionContext,
  ActivationTokenRecord,
  ActivityEvent,
  ActivityListQuery,
  Invitation,
  InvitationListQuery,
  InvitationRecord,
  InvitationStatus,
  Page,
  User,
  UserListQuery,
  UserProfile,
  UserStatus,
} from './types.js';
import { INVITATION_STATUSES, USER_STATUSES } from './types.js';
import {
  assertActivityType,
  assertExternalId,
  assertJsonObject,
  assertProvider,
  assertRoles,
  assertUserId,
  clampLimit,
  normaliseEmail,
  optionalText,
  positiveDuration,
  positiveInt,
  validateAvatarUrl,
  validateLocale,
  validateTimezone,
} from './validation.js';

const DAY = 86_400_000;

/** Permissions checked by the admin API through the PermissionChecker port. */
export const USERS_PERMISSIONS = [
  'users:read',
  'users:update',
  'users:suspend',
  'users:delete',
  'users:invite',
] as const;
export type UsersPermission = (typeof USERS_PERMISSIONS)[number];

export type DeletionPolicy = 'anonymise' | 'hard-delete';

export interface InvitationEmailContext {
  invitation: Invitation;
  token: string;
  /** `acceptUrl` with the token applied, when `acceptUrl` is configured. */
  acceptUrl: string | null;
  appName: string;
}

export interface InvitationEmailContent {
  subject: string;
  text: string;
  html?: string;
}

export interface UsersHookEvents {
  'user.created': { user: User; context: ActionContext };
  'user.status_changed': { user: User; from: UserStatus; to: UserStatus; context: ActionContext };
  'user.deletion_requested': { user: User; context: ActionContext };
  'user.deletion_cancelled': { user: User; context: ActionContext };
  /**
   * Awaited before a purge. Delete application data owned by the user here; throwing aborts
   * the purge (it is retried by the next `purgeExpired` run or job attempt).
   */
  'user.purging': { user: User; policy: DeletionPolicy };
  'user.purged': { userId: string; policy: DeletionPolicy };
  'invitation.accepted': { invitation: Invitation; user: User; created: boolean };
}

export type UsersHookName = keyof UsersHookEvents;
export type UsersHookListener<K extends UsersHookName> = (
  event: UsersHookEvents[K],
) => void | Promise<void>;
export type UsersHooks = { [K in UsersHookName]?: UsersHookListener<K> };

export interface UsersOptions {
  store: UsersStore;
  /** Sends invitation emails (category `users.invitation`). Without it tokens are returned. */
  mailer?: Mailer;
  /** Schedules `users.purge` jobs when deletion is requested. */
  jobs?: JobQueue;
  audit?: AuditSink;
  /** Authorises admin API routes (`users:read`, `users:update`, ...). */
  permissions?: PermissionChecker;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  /** Status of users created with `createUser` when no status is given. Default `active`. */
  defaultStatus?: 'pending' | 'active';
  /** Application-defined custom profile fields (`profile.fields`). */
  profileFields?: FieldDefinitions;
  /** Typed account settings. Not user editable unless a definition sets `userEditable`. */
  settings?: FieldDefinitions;
  /** Typed user preferences with defaults. User editable unless `userEditable: false`. */
  preferences?: FieldDefinitions;
  profile?: {
    /** Default 100. */
    displayNameMaxLength?: number;
    /** Default 2000. */
    bioMaxLength?: number;
    /** Allow `http:` avatar URLs (default false: only `https:`). */
    allowHttpAvatars?: boolean;
  };
  activation?: {
    /** Activation token lifetime. Default 72 hours. */
    tokenTtlMs?: number;
  };
  invitations?: {
    /** Invitation lifetime. Default 7 days. */
    ttlMs?: number;
    /** Minimum time between sends of the same invitation. Default 60 seconds. */
    resendIntervalMs?: number;
    /** Maximum number of sends per invitation (initial send included). Default 5. */
    maxSends?: number;
    /** Link in the email. `{token}` is replaced by the URL-encoded token; otherwise `?token=` is appended. */
    acceptUrl?: string;
    /** Application name used in the default email. Default `our application`. */
    appName?: string;
    /** Custom email renderer. */
    renderEmail?: (ctx: InvitationEmailContext) => InvitationEmailContent;
  };
  deletion?: {
    /** Grace period before purge. Default 30 days. */
    gracePeriodMs?: number;
    /** `anonymise` (default) keeps a scrubbed row; `hard-delete` removes it. */
    policy?: DeletionPolicy;
  };
  activity?: {
    /** Retention used by `pruneActivity()`. Default 365 days. */
    retentionMs?: number;
    /** Maximum serialised metadata size per event. Default 2048 bytes. */
    maxMetadataBytes?: number;
  };
  /** Metadata object size limit. Default 16384 bytes. */
  maxMetadataBytes?: number;
  hooks?: UsersHooks;
}

export interface ProfilePatch {
  displayName?: string | null;
  avatarUrl?: string | null;
  locale?: string | null;
  timezone?: string | null;
  bio?: string | null;
  /** Custom field values; `null` clears a field. */
  fields?: Record<string, unknown>;
}

export interface CreateUserInput {
  /** Supply the ID used by your auth system to link accounts. Generated when omitted. */
  id?: string;
  email: string;
  status?: 'pending' | 'active';
  externalId?: string;
  authProvider?: string;
  profile?: ProfilePatch;
  settings?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateOptions {
  /** Fails with USERS_VERSION_CONFLICT unless the stored version matches. */
  expectedVersion?: number;
  /** Enforces `userEditable` on field definitions (self-service callers). */
  selfService?: boolean;
}

export interface SuspendInput {
  reason: string;
  /** Automatic reinstatement time (Date or epoch ms). */
  until?: Date | number;
}

export interface InviteInput {
  email: string;
  roles?: string[];
  metadata?: Record<string, unknown>;
  /** Override the invitation lifetime for this invitation. */
  ttlMs?: number;
}

export type InvitationDelivery = 'sent' | 'failed' | 'manual';

export interface InvitationResult {
  invitation: Invitation;
  delivery: InvitationDelivery;
  /** Present only when `delivery` is `manual` (no mailer): deliver it yourself. */
  token?: string;
}

export interface AcceptInvitationInput {
  /** ID for a newly created user (for example the auth account ID). */
  userId?: string;
  profile?: ProfilePatch;
}

export interface AcceptInvitationResult {
  user: User;
  invitation: Invitation;
  /** True when this call created the user account. */
  created: boolean;
}

export interface RequestDeletionInput {
  reason?: string;
  /** Override the grace period (ms). `0` makes the account purgeable immediately. */
  gracePeriodMs?: number;
}

export interface RecordActivityInput {
  type: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  actorId?: string;
  /** Event time (defaults to now). */
  at?: number;
}

export interface UserDataExport {
  format: 'aspec.users.export';
  version: 1;
  exportedAt: string;
  user: User;
  effectiveSettings: Record<string, unknown>;
  effectivePreferences: Record<string, unknown>;
  invitations: Invitation[];
  activationTokens: Array<Omit<ActivationTokenRecord, 'tokenHash'>>;
  activity: ActivityEvent[];
}

export interface MaintenanceResult {
  purged: number;
  reinstated: number;
  activityPruned: number;
}

export interface UsersService {
  readonly store: UsersStore;
  readonly hasPermissionChecker: boolean;
  readonly settingDefinitions: FieldDefinitions;
  readonly preferenceDefinitions: FieldDefinitions;
  readonly profileFieldDefinitions: FieldDefinitions;

  createUser(input: CreateUserInput, context?: ActionContext): Promise<User>;
  getUser(id: string): Promise<User>;
  findUser(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserByExternalId(authProvider: string, externalId: string): Promise<User | null>;
  listUsers(query?: UserListQuery): Promise<Page<User>>;
  /** True when the account may sign in (status `active`, expired suspensions reinstated). */
  canSignIn(id: string): Promise<boolean>;

  updateProfile(
    id: string,
    patch: ProfilePatch,
    options?: UpdateOptions,
    context?: ActionContext,
  ): Promise<User>;
  changeEmail(
    id: string,
    email: string,
    options?: UpdateOptions,
    context?: ActionContext,
  ): Promise<User>;
  linkIdentity(
    id: string,
    identity: { authProvider: string; externalId: string } | null,
    options?: UpdateOptions,
    context?: ActionContext,
  ): Promise<User>;
  updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
    options?: UpdateOptions,
    context?: ActionContext,
  ): Promise<User>;
  getSettings(id: string): Promise<Record<string, unknown>>;
  updateSettings(
    id: string,
    patch: Record<string, unknown>,
    options?: UpdateOptions,
    context?: ActionContext,
  ): Promise<User>;
  getPreferences(id: string): Promise<Record<string, unknown>>;
  updatePreferences(
    id: string,
    patch: Record<string, unknown>,
    options?: UpdateOptions,
    context?: ActionContext,
  ): Promise<User>;

  suspendUser(id: string, input: SuspendInput, context?: ActionContext): Promise<User>;
  reactivateUser(id: string, context?: ActionContext): Promise<User>;
  reinstateExpiredSuspensions(limit?: number): Promise<number>;
  activateUser(id: string, context?: ActionContext): Promise<User>;
  createActivationToken(
    id: string,
    context?: ActionContext,
  ): Promise<{ token: string; expiresAt: number }>;
  activateWithToken(token: string, context?: ActionContext): Promise<User>;

  inviteUser(input: InviteInput, context?: ActionContext): Promise<InvitationResult>;
  resendInvitation(id: string, context?: ActionContext): Promise<InvitationResult>;
  revokeInvitation(id: string, context?: ActionContext): Promise<Invitation>;
  acceptInvitation(
    token: string,
    input?: AcceptInvitationInput,
    context?: ActionContext,
  ): Promise<AcceptInvitationResult>;
  getInvitation(id: string): Promise<Invitation>;
  listInvitations(query?: InvitationListQuery): Promise<Page<Invitation>>;

  requestDeletion(id: string, input?: RequestDeletionInput, context?: ActionContext): Promise<User>;
  cancelDeletion(id: string, context?: ActionContext): Promise<User>;
  purgeUser(
    id: string,
    options?: { force?: boolean },
    context?: ActionContext,
  ): Promise<{ purged: boolean; policy: DeletionPolicy }>;
  purgeExpired(limit?: number): Promise<{ purged: string[]; failed: string[] }>;
  exportUserData(id: string, context?: ActionContext): Promise<UserDataExport>;

  recordActivity(userId: string, input: RecordActivityInput): Promise<ActivityEvent>;
  recordLogin(userId: string, input?: Omit<RecordActivityInput, 'type'>): Promise<ActivityEvent>;
  listActivity(userId: string, query?: ActivityListQuery): Promise<Page<ActivityEvent>>;
  pruneActivity(options?: { olderThanMs?: number }): Promise<number>;
  runMaintenance(): Promise<MaintenanceResult>;

  /** Delegates to the PermissionChecker; false when none is configured. */
  can(subject: Subject, permission: string, resource?: ResourceRef): Promise<boolean>;
  on<K extends UsersHookName>(event: K, listener: UsersHookListener<K>): () => void;
}

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      err: { name: err.name, message: err.message, code: (err as { code?: unknown }).code },
    };
  }
  return { err: String(err) };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function toTime(option: string, value: Date | number | undefined): number | null {
  if (value === undefined) return null;
  const n = value instanceof Date ? value.getTime() : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw validationError([{ path: option, message: 'must be a valid date' }]);
  }
  return n;
}

function emptyProfile(): UserProfile {
  return {
    displayName: null,
    avatarUrl: null,
    locale: null,
    timezone: null,
    bio: null,
    fields: {},
  };
}

function diffObject(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return { before: b, after: a };
}

/** Creates the user management service. */
export function createUsers(options: UsersOptions): UsersService {
  if (!options || typeof options !== 'object') {
    throw new UsersError('USERS_CONFIG_INVALID', 'createUsers(options) requires an options object');
  }
  const store = options.store;
  if (!store || typeof store.insertUser !== 'function') {
    throw new UsersError('USERS_CONFIG_INVALID', 'options.store must implement UsersStore');
  }
  const logger = options.logger ?? noopLogger;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const generateId: IdGenerator = options.generateId ?? (() => uuidv7(clock.now()));
  const defaultStatus = options.defaultStatus ?? 'active';
  if (defaultStatus !== 'active' && defaultStatus !== 'pending') {
    throw new UsersError('USERS_CONFIG_INVALID', 'options.defaultStatus must be active or pending');
  }
  const profileDefs = options.profileFields ?? {};
  const settingDefs = options.settings ?? {};
  const preferenceDefs = options.preferences ?? {};
  assertFieldDefinitions('options.profileFields', profileDefs);
  assertFieldDefinitions('options.settings', settingDefs);
  assertFieldDefinitions('options.preferences', preferenceDefs);

  const displayNameMax = positiveInt(
    'options.profile.displayNameMaxLength',
    options.profile?.displayNameMaxLength,
    100,
  );
  const bioMax = positiveInt('options.profile.bioMaxLength', options.profile?.bioMaxLength, 2000);
  const allowHttpAvatars = options.profile?.allowHttpAvatars === true;
  const activationTtl = positiveDuration(
    'options.activation.tokenTtlMs',
    options.activation?.tokenTtlMs,
    3 * DAY,
  );
  const invitationTtl = positiveDuration(
    'options.invitations.ttlMs',
    options.invitations?.ttlMs,
    7 * DAY,
  );
  const resendInterval = positiveDuration(
    'options.invitations.resendIntervalMs',
    options.invitations?.resendIntervalMs,
    60_000,
  );
  const maxSends = positiveInt('options.invitations.maxSends', options.invitations?.maxSends, 5);
  const appName = options.invitations?.appName ?? 'our application';
  const acceptUrl = options.invitations?.acceptUrl;
  const renderEmail = options.invitations?.renderEmail;
  if (acceptUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(acceptUrl.replace('{token}', 'token'));
    } catch {
      throw new UsersError(
        'USERS_CONFIG_INVALID',
        'options.invitations.acceptUrl must be an absolute URL',
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new UsersError(
        'USERS_CONFIG_INVALID',
        'options.invitations.acceptUrl must use http or https',
      );
    }
  }
  if (options.mailer && acceptUrl === undefined && renderEmail === undefined) {
    throw new UsersError(
      'USERS_CONFIG_INVALID',
      'options.invitations.acceptUrl (or renderEmail) is required when a mailer is configured',
    );
  }
  const gracePeriod =
    options.deletion?.gracePeriodMs === undefined
      ? 30 * DAY
      : (() => {
          const g = options.deletion?.gracePeriodMs;
          if (typeof g !== 'number' || !Number.isFinite(g) || g < 0) {
            throw new UsersError(
              'USERS_CONFIG_INVALID',
              'options.deletion.gracePeriodMs must be >= 0',
            );
          }
          return g;
        })();
  const policy: DeletionPolicy = options.deletion?.policy ?? 'anonymise';
  if (policy !== 'anonymise' && policy !== 'hard-delete') {
    throw new UsersError(
      'USERS_CONFIG_INVALID',
      'options.deletion.policy must be anonymise or hard-delete',
    );
  }
  const retention = positiveDuration(
    'options.activity.retentionMs',
    options.activity?.retentionMs,
    365 * DAY,
  );
  const activityMetaMax = positiveInt(
    'options.activity.maxMetadataBytes',
    options.activity?.maxMetadataBytes,
    2048,
  );
  const metadataMax = positiveInt('options.maxMetadataBytes', options.maxMetadataBytes, 16_384);

  const listeners = new Map<UsersHookName, Set<(e: never) => void | Promise<void>>>();
  const on = <K extends UsersHookName>(event: K, listener: UsersHookListener<K>) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const fn = listener as (e: never) => void | Promise<void>;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  };
  for (const [name, fn] of Object.entries(options.hooks ?? {})) {
    if (typeof fn === 'function') on(name as UsersHookName, fn as UsersHookListener<UsersHookName>);
  }

  async function emit<K extends UsersHookName>(
    event: K,
    payload: UsersHookEvents[K],
  ): Promise<void> {
    for (const fn of listeners.get(event) ?? []) {
      try {
        await (fn as UsersHookListener<K>)(payload);
      } catch (err) {
        logger.error({ hook: event, ...errInfo(err) }, 'users hook listener failed');
      }
    }
  }

  async function emitBlocking<K extends UsersHookName>(
    event: K,
    payload: UsersHookEvents[K],
  ): Promise<void> {
    for (const fn of listeners.get(event) ?? []) {
      try {
        await (fn as UsersHookListener<K>)(payload);
      } catch (err) {
        throw new UsersError('USERS_HOOK_FAILED', `The ${event} hook failed`, {
          cause: err,
          expose: false,
        });
      }
    }
  }

  async function audit(
    action: string,
    context: ActionContext,
    event: Omit<AuditEventInput, 'action' | 'actor' | 'requestId' | 'tenantId'>,
  ): Promise<void> {
    if (!options.audit) return;
    const input: AuditEventInput = { action, outcome: 'success', ...event };
    if (context.actor) {
      const actor: NonNullable<AuditEventInput['actor']> = { id: context.actor.id };
      if (context.actor.type !== undefined) actor.type = context.actor.type;
      if (context.actor.ip !== undefined) actor.ip = context.actor.ip;
      if (context.actor.userAgent !== undefined) actor.userAgent = context.actor.userAgent;
      input.actor = actor;
    }
    if (context.requestId !== undefined) input.requestId = context.requestId;
    if (context.tenantId !== undefined) input.tenantId = context.tenantId;
    try {
      await options.audit.record(input);
    } catch (err) {
      logger.error({ action, ...errInfo(err) }, 'users audit sink failed');
    }
  }

  async function activity(
    userId: string,
    type: string,
    context: ActionContext,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const event: ActivityEvent = {
      id: generateId(),
      userId,
      type,
      at: clock.now(),
      actorId: context.actor?.id ?? null,
      ip: context.actor?.ip?.slice(0, 100) ?? null,
      userAgent: context.actor?.userAgent?.slice(0, 512) ?? null,
      metadata,
    };
    try {
      await store.appendActivity(event);
    } catch (err) {
      logger.error({ userId, type, ...errInfo(err) }, 'users activity append failed');
    }
  }

  async function reinstateIfExpired(user: User): Promise<User> {
    if (
      user.status !== 'suspended' ||
      user.suspension?.until == null ||
      user.suspension.until > clock.now()
    ) {
      return user;
    }
    const now = clock.now();
    const to = user.suspension.previousStatus;
    const next: User = {
      ...user,
      status: to,
      suspension: null,
      updatedAt: now,
      version: user.version + 1,
    };
    if (!(await store.updateUser(next, user.version))) {
      const fresh = await store.getUser(user.id);
      return fresh ?? user;
    }
    const ctx: ActionContext = { actor: { id: 'system', type: 'system' } };
    await audit('users.reactivated', ctx, {
      category: 'admin',
      resource: { type: 'user', id: user.id },
      changes: { before: { status: 'suspended' }, after: { status: to } },
      metadata: { reason: 'suspension_expired' },
    });
    await activity(user.id, 'status.changed', ctx, {
      from: 'suspended',
      to,
      reason: 'suspension_expired',
    });
    await emit('user.status_changed', { user: next, from: 'suspended', to, context: ctx });
    return next;
  }

  async function findUser(id: string): Promise<User | null> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    const user = await store.getUser(id);
    return user ? reinstateIfExpired(user) : null;
  }

  async function getUser(id: string): Promise<User> {
    const user = await findUser(id);
    if (!user) throw new UsersError('USERS_NOT_FOUND', 'User not found');
    return user;
  }

  async function mutate(
    id: string,
    expectedVersion: number | undefined,
    fn: (user: User) => User | Promise<User>,
  ): Promise<{ before: User; after: User }> {
    if (
      expectedVersion !== undefined &&
      (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    ) {
      throw validationError([{ path: 'expectedVersion', message: 'must be a positive integer' }]);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await getUser(id);
      if (expectedVersion !== undefined && before.version !== expectedVersion) {
        throw new UsersError('USERS_VERSION_CONFLICT', 'The user was modified by another request', {
          details: { currentVersion: before.version },
        });
      }
      const draft = await fn(structuredClone(before));
      const after: User = {
        ...draft,
        id: before.id,
        version: before.version + 1,
        updatedAt: clock.now(),
      };
      if (await store.updateUser(after, before.version)) return { before, after };
      if (expectedVersion !== undefined) {
        throw new UsersError('USERS_VERSION_CONFLICT', 'The user was modified by another request');
      }
    }
    throw new UsersError(
      'USERS_VERSION_CONFLICT',
      'The user is being modified concurrently; retry',
    );
  }

  function assertNotDeleted(user: User): void {
    if (user.status === 'deleted') {
      throw new UsersError('USERS_INVALID_STATE', 'The account is deleted or pending deletion');
    }
  }

  async function buildProfile(
    current: UserProfile,
    patch: unknown,
    selfService: boolean,
  ): Promise<UserProfile> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw validationError([{ path: 'profile', message: 'must be an object' }]);
    }
    const p = patch as Record<string, unknown>;
    const issues: ValidationIssue[] = [];
    const allowed = new Set(['displayName', 'avatarUrl', 'locale', 'timezone', 'bio', 'fields']);
    for (const key of Object.keys(p)) {
      if (!allowed.has(key))
        issues.push({ path: `profile.${key}`, message: 'is not a profile field' });
    }
    const next: UserProfile = { ...current, fields: { ...current.fields } };
    const displayName = optionalText(p.displayName, 'profile.displayName', displayNameMax, issues);
    if (displayName !== undefined) next.displayName = displayName;
    const avatarUrl = validateAvatarUrl(p.avatarUrl, allowHttpAvatars, issues);
    if (avatarUrl !== undefined) next.avatarUrl = avatarUrl;
    const locale = validateLocale(p.locale, issues);
    if (locale !== undefined) next.locale = locale;
    const timezone = validateTimezone(p.timezone, issues);
    if (timezone !== undefined) next.timezone = timezone;
    const bio = optionalText(p.bio, 'profile.bio', bioMax, issues, { allowNewlines: true });
    if (bio !== undefined) next.bio = bio;
    if (p.fields !== undefined) {
      next.fields = await applyFieldPatch(
        profileDefs,
        current.fields,
        p.fields,
        { path: 'profile.fields', selfService, editableByDefault: true, allowUnknown: false },
        issues,
      );
    }
    checkRequired(profileDefs, next.fields, 'profile.fields', issues);
    if (issues.length > 0) throw validationError(issues);
    return next;
  }

  function effectiveInvitationStatus(inv: InvitationRecord): InvitationStatus {
    return inv.status === 'pending' && inv.expiresAt <= clock.now() ? 'expired' : inv.status;
  }

  function publicInvitation(inv: InvitationRecord): Invitation {
    const { tokenHash: _omit, ...rest } = inv;
    return { ...structuredClone(rest), status: effectiveInvitationStatus(inv) };
  }

  function buildAcceptUrl(token: string): string | null {
    if (acceptUrl === undefined) return null;
    const encoded = encodeURIComponent(token);
    if (acceptUrl.includes('{token}')) return acceptUrl.replace('{token}', encoded);
    const url = new URL(acceptUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }

  function defaultEmail(ctx: InvitationEmailContext): InvitationEmailContent {
    const link = ctx.acceptUrl ?? ctx.token;
    const days = Math.max(1, Math.round((ctx.invitation.expiresAt - clock.now()) / DAY));
    const text = [
      `You have been invited to join ${ctx.appName}.`,
      '',
      ctx.acceptUrl ? `Accept the invitation: ${link}` : `Your invitation code: ${link}`,
      '',
      `This invitation expires in ${days} day${days === 1 ? '' : 's'}. If you did not expect it, ignore this email.`,
    ].join('\n');
    const html = `<p>You have been invited to join ${escapeHtml(ctx.appName)}.</p><p>${
      ctx.acceptUrl
        ? `<a href="${escapeHtml(link)}">Accept the invitation</a>`
        : `Your invitation code: <code>${escapeHtml(link)}</code>`
    }</p><p>This invitation expires in ${days} day${days === 1 ? '' : 's'}. If you did not expect it, ignore this email.</p>`;
    return { subject: `You have been invited to ${ctx.appName}`, text, html };
  }

  async function deliver(inv: InvitationRecord, token: string): Promise<InvitationResult> {
    if (!options.mailer) {
      return { invitation: publicInvitation(inv), delivery: 'manual', token };
    }
    const ctx: InvitationEmailContext = {
      invitation: publicInvitation(inv),
      token,
      acceptUrl: buildAcceptUrl(token),
      appName,
    };
    try {
      const content = (renderEmail ?? defaultEmail)(ctx);
      const message: Parameters<Mailer['send']>[0] = {
        to: inv.email,
        subject: content.subject,
        text: content.text,
        category: 'users.invitation',
        metadata: { invitationId: inv.id },
      };
      if (content.html !== undefined) message.html = content.html;
      await options.mailer.send(message);
      return { invitation: publicInvitation(inv), delivery: 'sent' };
    } catch (err) {
      logger.error({ invitationId: inv.id, ...errInfo(err) }, 'users invitation email failed');
      return { invitation: publicInvitation(inv), delivery: 'failed' };
    }
  }

  async function getInvitationRecord(id: string): Promise<InvitationRecord> {
    const inv = typeof id === 'string' && id.length <= 128 ? await store.getInvitation(id) : null;
    if (!inv) throw new UsersError('USERS_INVITATION_NOT_FOUND', 'Invitation not found');
    return inv;
  }

  async function updateInvitationOrConflict(
    next: InvitationRecord,
    expected: number,
  ): Promise<void> {
    if (!(await store.updateInvitation(next, expected))) {
      throw new UsersError(
        'USERS_VERSION_CONFLICT',
        'The invitation was modified concurrently; retry',
      );
    }
  }

  async function createUser(input: CreateUserInput, context: ActionContext = {}): Promise<User> {
    if (!input || typeof input !== 'object') {
      throw validationError([{ path: '', message: 'input must be an object' }]);
    }
    const now = clock.now();
    const id = input.id === undefined ? generateId() : assertUserId(input.id);
    const email = normaliseEmail(input.email);
    const status = input.status ?? defaultStatus;
    if (status !== 'active' && status !== 'pending') {
      throw validationError([{ path: 'status', message: 'must be active or pending' }]);
    }
    if ((input.externalId === undefined) !== (input.authProvider === undefined)) {
      throw validationError([
        { path: 'externalId', message: 'externalId and authProvider must be supplied together' },
      ]);
    }
    const externalId =
      input.externalId === undefined ? null : assertExternalId(input.externalId, 'externalId');
    const authProvider =
      input.authProvider === undefined ? null : assertProvider(input.authProvider, 'authProvider');
    const profile = await buildProfile(emptyProfile(), input.profile ?? {}, false);
    const issues: ValidationIssue[] = [];
    const settings = await applyFieldPatch(
      settingDefs,
      {},
      input.settings ?? {},
      { path: 'settings', selfService: false, editableByDefault: false, allowUnknown: false },
      issues,
    );
    const preferences = await applyFieldPatch(
      preferenceDefs,
      {},
      input.preferences ?? {},
      { path: 'preferences', selfService: false, editableByDefault: true, allowUnknown: false },
      issues,
    );
    if (issues.length > 0) throw validationError(issues);
    const user: User = {
      id,
      email,
      status,
      externalId,
      authProvider,
      profile,
      settings,
      preferences,
      metadata: assertJsonObject(input.metadata, 'metadata', metadataMax),
      suspension: null,
      deletion: null,
      createdAt: now,
      updatedAt: now,
      activatedAt: status === 'active' ? now : null,
      lastLoginAt: null,
      purgedAt: null,
      version: 1,
    };
    await store.insertUser(user);
    await audit('users.created', context, {
      category: 'data',
      resource: { type: 'user', id },
      changes: { after: { email, status, externalId, authProvider } },
    });
    await activity(id, 'created', context, { status });
    await emit('user.created', { user, context });
    return user;
  }

  async function listUsers(query: UserListQuery = {}): Promise<Page<User>> {
    const limit = clampLimit(query.limit);
    if (query.status !== undefined && !USER_STATUSES.includes(query.status)) {
      throw validationError([
        { path: 'status', message: `must be one of ${USER_STATUSES.join(', ')}` },
      ]);
    }
    const search =
      query.search === undefined
        ? undefined
        : String(query.search).trim().toLowerCase().slice(0, 100);
    const after = decodeCursor(query.cursor);
    const storeQuery: Parameters<UsersStore['listUsers']>[0] = { limit };
    if (query.status) storeQuery.status = query.status;
    if (search) storeQuery.search = search;
    if (after) storeQuery.after = { createdAt: after.time, id: after.id };
    const rows = await store.listUsers(storeQuery);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor: rows.length === limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async function updateFields(
    kind: 'settings' | 'preferences',
    id: string,
    patch: Record<string, unknown>,
    opts: UpdateOptions,
    context: ActionContext,
  ): Promise<User> {
    const defs = kind === 'settings' ? settingDefs : preferenceDefs;
    const { before, after } = await mutate(id, opts.expectedVersion, async (u) => {
      assertNotDeleted(u);
      const issues: ValidationIssue[] = [];
      const next = await applyFieldPatch(
        defs,
        u[kind],
        patch,
        {
          path: kind,
          selfService: opts.selfService === true,
          editableByDefault: kind === 'preferences',
          allowUnknown: false,
        },
        issues,
      );
      if (issues.length > 0) throw validationError(issues);
      u[kind] = next;
      return u;
    });
    const changes = diffObject(before[kind], after[kind]);
    await audit(`users.${kind}.updated`, context, {
      category: 'data',
      resource: { type: 'user', id },
      changes,
    });
    await activity(id, `${kind}.updated`, context, { keys: Object.keys(changes.after) });
    return after;
  }

  const service: UsersService = {
    store,
    hasPermissionChecker: options.permissions !== undefined,
    settingDefinitions: settingDefs,
    preferenceDefinitions: preferenceDefs,
    profileFieldDefinitions: profileDefs,

    createUser,
    getUser,
    findUser,
    async findUserByEmail(email) {
      let normalised: string;
      try {
        normalised = normaliseEmail(email);
      } catch {
        return null;
      }
      const user = await store.getUserByEmail(normalised);
      return user ? reinstateIfExpired(user) : null;
    },
    async findUserByExternalId(authProvider, externalId) {
      const user = await store.getUserByExternalId(
        assertProvider(authProvider, 'authProvider'),
        assertExternalId(externalId, 'externalId'),
      );
      return user ? reinstateIfExpired(user) : null;
    },
    listUsers,
    async canSignIn(id) {
      const user = await findUser(id);
      return user?.status === 'active';
    },

    async updateProfile(id, patch, opts = {}, context = {}) {
      const { before, after } = await mutate(id, opts.expectedVersion, async (u) => {
        assertNotDeleted(u);
        u.profile = await buildProfile(u.profile, patch, opts.selfService === true);
        return u;
      });
      const { fields: bf, ...bRest } = before.profile;
      const { fields: af, ...aRest } = after.profile;
      const changes = diffObject({ ...bRest, fields: bf }, { ...aRest, fields: af });
      await audit('users.profile.updated', context, {
        category: 'data',
        resource: { type: 'user', id },
        changes,
      });
      await activity(id, 'profile.updated', context, { fields: Object.keys(changes.after) });
      return after;
    },

    async changeEmail(id, email, opts = {}, context = {}) {
      const normalised = normaliseEmail(email);
      const { before, after } = await mutate(id, opts.expectedVersion, (u) => {
        assertNotDeleted(u);
        u.email = normalised;
        return u;
      });
      if (before.email !== after.email) {
        await audit('users.email.changed', context, {
          category: 'security',
          resource: { type: 'user', id },
          changes: { before: { email: before.email }, after: { email: after.email } },
        });
        await activity(id, 'email.changed', context);
      }
      return after;
    },

    async linkIdentity(id, identity, opts = {}, context = {}) {
      const authProvider =
        identity === null ? null : assertProvider(identity.authProvider, 'authProvider');
      const externalId =
        identity === null ? null : assertExternalId(identity.externalId, 'externalId');
      const { before, after } = await mutate(id, opts.expectedVersion, (u) => {
        assertNotDeleted(u);
        u.authProvider = authProvider;
        u.externalId = externalId;
        return u;
      });
      await audit(
        identity === null ? 'users.identity.unlinked' : 'users.identity.linked',
        context,
        {
          category: 'security',
          resource: { type: 'user', id },
          changes: {
            before: { authProvider: before.authProvider, externalId: before.externalId },
            after: { authProvider, externalId },
          },
        },
      );
      await activity(id, identity === null ? 'identity.unlinked' : 'identity.linked', context, {
        authProvider: authProvider ?? before.authProvider,
      });
      return after;
    },

    async updateMetadata(id, metadata, opts = {}, context = {}) {
      const next = assertJsonObject(metadata, 'metadata', metadataMax);
      const { before, after } = await mutate(id, opts.expectedVersion, (u) => {
        assertNotDeleted(u);
        u.metadata = next;
        return u;
      });
      await audit('users.metadata.updated', context, {
        category: 'data',
        resource: { type: 'user', id },
        changes: diffObject(before.metadata, after.metadata),
      });
      return after;
    },

    async getSettings(id) {
      const user = await getUser(id);
      return mergeWithDefaults(settingDefs, user.settings);
    },
    updateSettings(id, patch, opts = {}, context = {}) {
      return updateFields('settings', id, patch, opts, context);
    },
    async getPreferences(id) {
      const user = await getUser(id);
      return mergeWithDefaults(preferenceDefs, user.preferences);
    },
    updatePreferences(id, patch, opts = {}, context = {}) {
      return updateFields('preferences', id, patch, opts, context);
    },

    async suspendUser(id, input, context = {}) {
      const issues: ValidationIssue[] = [];
      const reason = optionalText(input?.reason, 'reason', 500, issues, { allowNewlines: true });
      if (!reason) issues.push({ path: 'reason', message: 'is required' });
      if (issues.length > 0) throw validationError(issues);
      const until = toTime('until', input.until);
      if (until !== null && until <= clock.now()) {
        throw validationError([{ path: 'until', message: 'must be in the future' }]);
      }
      const { before, after } = await mutate(id, undefined, (u) => {
        if (u.status !== 'active' && u.status !== 'pending') {
          throw new UsersError('USERS_INVALID_STATE', `Cannot suspend a ${u.status} account`);
        }
        u.suspension = {
          reason: reason as string,
          actorId: context.actor?.id ?? null,
          suspendedAt: clock.now(),
          until,
          previousStatus: u.status,
        };
        u.status = 'suspended';
        return u;
      });
      await audit('users.suspended', context, {
        category: 'admin',
        resource: { type: 'user', id },
        changes: { before: { status: before.status }, after: { status: 'suspended', until } },
        metadata: { reason },
      });
      await activity(id, 'status.changed', context, {
        from: before.status,
        to: 'suspended',
        until,
      });
      await emit('user.status_changed', {
        user: after,
        from: before.status,
        to: 'suspended',
        context,
      });
      return after;
    },

    async reactivateUser(id, context = {}) {
      const { before, after } = await mutate(id, undefined, (u) => {
        if (u.status !== 'suspended' || !u.suspension) {
          throw new UsersError('USERS_INVALID_STATE', 'Only suspended accounts can be reactivated');
        }
        u.status = u.suspension.previousStatus;
        u.suspension = null;
        return u;
      });
      await audit('users.reactivated', context, {
        category: 'admin',
        resource: { type: 'user', id },
        changes: { before: { status: before.status }, after: { status: after.status } },
      });
      await activity(id, 'status.changed', context, { from: before.status, to: after.status });
      await emit('user.status_changed', {
        user: after,
        from: before.status,
        to: after.status,
        context,
      });
      return after;
    },

    async reinstateExpiredSuspensions(limit = 500) {
      const due = await store.listExpiredSuspensions(clock.now(), clampLimit(limit, 500, 5000));
      let n = 0;
      for (const user of due) {
        const next = await reinstateIfExpired(user);
        if (next.status !== 'suspended') n++;
      }
      return n;
    },

    async activateUser(id, context = {}) {
      const { before, after } = await mutate(id, undefined, (u) => {
        if (u.status !== 'pending') {
          throw new UsersError('USERS_INVALID_STATE', `Cannot activate a ${u.status} account`);
        }
        u.status = 'active';
        u.activatedAt = clock.now();
        return u;
      });
      await store.deleteActivationTokens(id);
      await audit('users.activated', context, {
        category: 'admin',
        resource: { type: 'user', id },
        changes: { before: { status: before.status }, after: { status: 'active' } },
        metadata: { method: 'admin' },
      });
      await activity(id, 'status.changed', context, {
        from: 'pending',
        to: 'active',
        method: 'admin',
      });
      await emit('user.status_changed', { user: after, from: 'pending', to: 'active', context });
      return after;
    },

    async createActivationToken(id, context = {}) {
      const user = await getUser(id);
      if (user.status !== 'pending') {
        throw new UsersError('USERS_INVALID_STATE', 'Only pending accounts can be activated');
      }
      await store.deleteActivationTokens(id);
      const recordId = uuidv7(clock.now());
      const { token, hash } = issueToken('act', recordId);
      const now = clock.now();
      const expiresAt = now + activationTtl;
      await store.insertActivationToken({
        id: recordId,
        userId: id,
        tokenHash: hash,
        createdAt: now,
        expiresAt,
        usedAt: null,
      });
      await audit('users.activation_token.created', context, {
        category: 'security',
        resource: { type: 'user', id },
        metadata: { expiresAt },
      });
      return { token, expiresAt };
    },

    async activateWithToken(token, context = {}) {
      const parsed = parseToken('act', token);
      const invalid = () =>
        new UsersError('USERS_TOKEN_INVALID', 'The activation token is invalid');
      if (!parsed) throw invalid();
      const record = await store.getActivationToken(parsed.recordId);
      if (!record || !verifyTokenHash(token, record.tokenHash) || record.usedAt !== null) {
        throw invalid();
      }
      if (record.expiresAt <= clock.now()) {
        throw new UsersError('USERS_TOKEN_EXPIRED', 'The activation token has expired');
      }
      const user = await getUser(record.userId);
      if (user.status !== 'pending') throw invalid();
      if (!(await store.markActivationTokenUsed(record.id, clock.now()))) throw invalid();
      const { after } = await mutate(record.userId, undefined, (u) => {
        if (u.status !== 'pending') throw invalid();
        u.status = 'active';
        u.activatedAt = clock.now();
        return u;
      });
      const ctx: ActionContext = {
        ...context,
        actor: context.actor ?? { id: record.userId, type: 'user' },
      };
      await audit('users.activated', ctx, {
        category: 'security',
        resource: { type: 'user', id: record.userId },
        changes: { before: { status: 'pending' }, after: { status: 'active' } },
        metadata: { method: 'token' },
      });
      await activity(record.userId, 'status.changed', ctx, {
        from: 'pending',
        to: 'active',
        method: 'token',
      });
      await emit('user.status_changed', {
        user: after,
        from: 'pending',
        to: 'active',
        context: ctx,
      });
      return after;
    },

    async inviteUser(input, context = {}) {
      const email = normaliseEmail(input?.email);
      const roles = assertRoles(input.roles);
      const metadata = assertJsonObject(input.metadata, 'metadata', 4096);
      const ttl =
        input.ttlMs === undefined
          ? invitationTtl
          : positiveDuration('ttlMs', input.ttlMs, invitationTtl);
      const existing = await store.getUserByEmail(email);
      if (existing && existing.status !== 'pending') {
        throw new UsersError('USERS_ALREADY_ACTIVE', 'An account already exists for this email');
      }
      const pending = await store.findPendingInvitation(email);
      if (pending) {
        if (effectiveInvitationStatus(pending) === 'pending') {
          throw new UsersError(
            'USERS_INVITATION_EXISTS',
            'A pending invitation exists for this email; resend it instead',
            {
              details: { invitationId: pending.id },
            },
          );
        }
        await store.updateInvitation(
          { ...pending, status: 'expired', updatedAt: clock.now(), version: pending.version + 1 },
          pending.version,
        );
      }
      const id = generateId();
      if (!TOKEN_RECORD_ID.test(id)) {
        throw new UsersError(
          'USERS_CONFIG_INVALID',
          'generateId must return IDs matching [A-Za-z0-9_-]{1,128}',
        );
      }
      const { token, hash } = issueToken('inv', id);
      const now = clock.now();
      const record: InvitationRecord = {
        id,
        email,
        status: 'pending',
        roles,
        metadata,
        invitedBy: context.actor?.id ?? null,
        userId: null,
        tokenHash: hash,
        expiresAt: now + ttl,
        createdAt: now,
        updatedAt: now,
        lastSentAt: options.mailer ? now : null,
        sendCount: options.mailer ? 1 : 0,
        acceptedAt: null,
        revokedAt: null,
        version: 1,
      };
      await store.insertInvitation(record);
      const result = await deliver(record, token);
      await audit('users.invitation.created', context, {
        category: 'admin',
        resource: { type: 'invitation', id },
        changes: { after: { email, roles, expiresAt: record.expiresAt } },
        metadata: { delivery: result.delivery },
      });
      return result;
    },

    async resendInvitation(id, context = {}) {
      const inv = await getInvitationRecord(id);
      if (inv.status !== 'pending') {
        throw new UsersError('USERS_INVALID_STATE', `Cannot resend a ${inv.status} invitation`);
      }
      const now = clock.now();
      if (inv.sendCount >= maxSends) {
        throw new UsersError(
          'USERS_INVITATION_THROTTLED',
          'This invitation has been sent the maximum number of times',
          {
            details: { reason: 'max_sends', maxSends },
          },
        );
      }
      if (inv.lastSentAt !== null && now - inv.lastSentAt < resendInterval) {
        const retryAfterMs = resendInterval - (now - inv.lastSentAt);
        throw new UsersError(
          'USERS_INVITATION_THROTTLED',
          'The invitation was sent recently; try again later',
          {
            details: { reason: 'interval', retryAfterMs },
          },
        );
      }
      const { token, hash } = issueToken('inv', inv.id);
      const next: InvitationRecord = {
        ...inv,
        tokenHash: hash,
        expiresAt: now + invitationTtl,
        lastSentAt: now,
        sendCount: inv.sendCount + 1,
        updatedAt: now,
        version: inv.version + 1,
      };
      await updateInvitationOrConflict(next, inv.version);
      const result = await deliver(next, token);
      await audit('users.invitation.resent', context, {
        category: 'admin',
        resource: { type: 'invitation', id },
        metadata: { delivery: result.delivery, sendCount: next.sendCount },
      });
      return result;
    },

    async revokeInvitation(id, context = {}) {
      const inv = await getInvitationRecord(id);
      if (inv.status === 'revoked') return publicInvitation(inv);
      if (inv.status === 'accepted') {
        throw new UsersError('USERS_INVALID_STATE', 'An accepted invitation cannot be revoked');
      }
      const now = clock.now();
      const next: InvitationRecord = {
        ...inv,
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
        version: inv.version + 1,
      };
      await updateInvitationOrConflict(next, inv.version);
      await audit('users.invitation.revoked', context, {
        category: 'admin',
        resource: { type: 'invitation', id },
        changes: { before: { status: inv.status }, after: { status: 'revoked' } },
      });
      return publicInvitation(next);
    },

    async acceptInvitation(token, input = {}, context = {}) {
      const parsed = parseToken('inv', token);
      const invalid = () =>
        new UsersError('USERS_TOKEN_INVALID', 'The invitation token is invalid');
      if (!parsed) throw invalid();
      const inv = await store.getInvitation(parsed.recordId);
      if (!inv || !verifyTokenHash(token, inv.tokenHash)) throw invalid();
      if (inv.status === 'revoked') {
        throw new UsersError('USERS_INVITATION_REVOKED', 'The invitation was revoked');
      }
      if (inv.status === 'accepted') {
        const user = inv.userId ? await findUser(inv.userId) : null;
        if (!user) throw invalid();
        return { user, invitation: publicInvitation(inv), created: false };
      }
      if (inv.status === 'expired' || inv.expiresAt <= clock.now()) {
        throw new UsersError('USERS_INVITATION_EXPIRED', 'The invitation has expired');
      }
      const ctx: ActionContext = context;
      let user = await store.getUserByEmail(inv.email);
      let created = false;
      if (!user) {
        try {
          user = await createUser(
            {
              ...(input.userId === undefined ? {} : { id: input.userId }),
              email: inv.email,
              status: 'active',
              ...(input.profile === undefined ? {} : { profile: input.profile }),
              metadata: { invitation: { id: inv.id, roles: inv.roles, metadata: inv.metadata } },
            },
            ctx,
          );
          created = true;
        } catch (err) {
          if (!(err instanceof UsersError) || err.code !== 'USERS_EMAIL_TAKEN') throw err;
          const fresh = await store.getInvitation(inv.id);
          if (fresh?.status === 'accepted' && fresh.userId) {
            const existing = await getUser(fresh.userId);
            return { user: existing, invitation: publicInvitation(fresh), created: false };
          }
          user = await store.getUserByEmail(inv.email);
          if (!user) throw err;
        }
      }
      if (!created) {
        user = await reinstateIfExpired(user);
        if (user.status === 'suspended') {
          throw new UsersError('USERS_SUSPENDED', 'The account for this invitation is suspended');
        }
        if (user.status === 'deleted') {
          throw new UsersError('USERS_INVALID_STATE', 'The account for this invitation is deleted');
        }
        if (user.status === 'pending') {
          const { after } = await mutate(user.id, undefined, async (u) => {
            if (u.status !== 'pending') return u;
            u.status = 'active';
            u.activatedAt = clock.now();
            if (input.profile !== undefined)
              u.profile = await buildProfile(u.profile, input.profile, true);
            u.metadata = {
              ...u.metadata,
              invitation: { id: inv.id, roles: inv.roles, metadata: inv.metadata },
            };
            return u;
          });
          await store.deleteActivationTokens(user.id);
          await activity(user.id, 'status.changed', ctx, {
            from: 'pending',
            to: 'active',
            method: 'invitation',
          });
          await emit('user.status_changed', {
            user: after,
            from: 'pending',
            to: 'active',
            context: ctx,
          });
          user = after;
        }
      }
      const now = clock.now();
      const next: InvitationRecord = {
        ...inv,
        status: 'accepted',
        userId: user.id,
        acceptedAt: now,
        updatedAt: now,
        version: inv.version + 1,
      };
      if (!(await store.updateInvitation(next, inv.version))) {
        const fresh = await store.getInvitation(inv.id);
        if (fresh?.status === 'accepted' && fresh.userId === user.id) {
          return { user, invitation: publicInvitation(fresh), created };
        }
        throw new UsersError(
          'USERS_VERSION_CONFLICT',
          'The invitation was modified concurrently; retry',
        );
      }
      const acceptCtx: ActionContext = {
        ...ctx,
        actor: ctx.actor ?? { id: user.id, type: 'user' },
      };
      await audit('users.invitation.accepted', acceptCtx, {
        category: 'admin',
        resource: { type: 'invitation', id: inv.id },
        changes: { before: { status: 'pending' }, after: { status: 'accepted', userId: user.id } },
        metadata: { created, roles: inv.roles },
      });
      await activity(user.id, 'invitation.accepted', acceptCtx, { invitationId: inv.id });
      const invitation = publicInvitation(next);
      await emit('invitation.accepted', { invitation, user, created });
      return { user, invitation, created };
    },

    async getInvitation(id) {
      return publicInvitation(await getInvitationRecord(id));
    },

    async listInvitations(query = {}) {
      const limit = clampLimit(query.limit);
      if (query.status !== undefined && !INVITATION_STATUSES.includes(query.status)) {
        throw validationError([
          { path: 'status', message: `must be one of ${INVITATION_STATUSES.join(', ')}` },
        ]);
      }
      const after = decodeCursor(query.cursor);
      const storeQuery: Parameters<UsersStore['listInvitations']>[0] = { limit };
      if (query.status && query.status !== 'expired') storeQuery.status = query.status;
      if (query.email !== undefined) storeQuery.email = normaliseEmail(query.email);
      if (after) storeQuery.after = { createdAt: after.time, id: after.id };
      const rows = await store.listInvitations(storeQuery);
      const items = rows
        .map(publicInvitation)
        .filter((i) => query.status === undefined || i.status === query.status);
      const last = rows[rows.length - 1];
      return {
        items,
        nextCursor: rows.length === limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async requestDeletion(id, input = {}, context = {}) {
      const issues: ValidationIssue[] = [];
      const reason =
        optionalText(input.reason, 'reason', 500, issues, { allowNewlines: true }) ?? null;
      if (issues.length > 0) throw validationError(issues);
      let grace = gracePeriod;
      if (input.gracePeriodMs !== undefined) {
        if (
          typeof input.gracePeriodMs !== 'number' ||
          !Number.isFinite(input.gracePeriodMs) ||
          input.gracePeriodMs < 0
        ) {
          throw validationError([
            { path: 'gracePeriodMs', message: 'must be a non-negative number' },
          ]);
        }
        grace = input.gracePeriodMs;
      }
      const { before, after } = await mutate(id, undefined, (u) => {
        if (u.status === 'deleted') {
          throw new UsersError('USERS_INVALID_STATE', 'Deletion has already been requested');
        }
        const now = clock.now();
        u.deletion = {
          requestedAt: now,
          purgeAfter: now + grace,
          actorId: context.actor?.id ?? null,
          reason,
          previousStatus: u.status as 'pending' | 'active' | 'suspended',
        };
        u.status = 'deleted';
        return u;
      });
      const deletion = after.deletion as NonNullable<User['deletion']>;
      if (options.jobs) {
        try {
          await options.jobs.add(
            'users.purge',
            { userId: id },
            {
              runAt: new Date(deletion.purgeAfter),
              jobId: `users.purge:${id}:${deletion.requestedAt}`,
              maxAttempts: 10,
            },
          );
        } catch (err) {
          logger.warn(
            { userId: id, ...errInfo(err) },
            'users purge job scheduling failed; purgeExpired() will pick it up',
          );
        }
      }
      await audit('users.deletion.requested', context, {
        category: 'data',
        resource: { type: 'user', id },
        changes: {
          before: { status: before.status },
          after: { status: 'deleted', purgeAfter: deletion.purgeAfter },
        },
      });
      await activity(id, 'deletion.requested', context, { purgeAfter: deletion.purgeAfter });
      await emit('user.status_changed', {
        user: after,
        from: before.status,
        to: 'deleted',
        context,
      });
      await emit('user.deletion_requested', { user: after, context });
      return after;
    },

    async cancelDeletion(id, context = {}) {
      const { after } = await mutate(id, undefined, (u) => {
        if (u.status !== 'deleted' || !u.deletion || u.purgedAt !== null) {
          throw new UsersError('USERS_INVALID_STATE', 'No cancellable deletion request exists');
        }
        u.status = u.deletion.previousStatus;
        u.deletion = null;
        return u;
      });
      await audit('users.deletion.cancelled', context, {
        category: 'data',
        resource: { type: 'user', id },
        changes: { before: { status: 'deleted' }, after: { status: after.status } },
      });
      await activity(id, 'deletion.cancelled', context);
      await emit('user.status_changed', {
        user: after,
        from: 'deleted',
        to: after.status,
        context,
      });
      await emit('user.deletion_cancelled', { user: after, context });
      return after;
    },

    async purgeUser(id, opts = {}, context = {}) {
      const user = await store.getUser(id);
      if (!user) {
        if (policy === 'hard-delete') return { purged: false, policy };
        throw new UsersError('USERS_NOT_FOUND', 'User not found');
      }
      if (user.purgedAt !== null) return { purged: false, policy };
      if (user.status !== 'deleted' || !user.deletion) {
        throw new UsersError('USERS_INVALID_STATE', 'Request deletion before purging an account');
      }
      if (opts.force !== true && user.deletion.purgeAfter > clock.now()) {
        throw new UsersError('USERS_INVALID_STATE', 'The deletion grace period has not ended', {
          details: { purgeAfter: user.deletion.purgeAfter },
        });
      }
      await emitBlocking('user.purging', { user, policy });
      if (policy === 'hard-delete') {
        await store.deleteUser(id);
      } else {
        const now = clock.now();
        const anonymised: User = {
          ...user,
          email: `deleted-${sha256Hex(user.id).slice(0, 32)}@users.invalid`,
          externalId: null,
          authProvider: null,
          profile: emptyProfile(),
          settings: {},
          preferences: {},
          metadata: {},
          suspension: null,
          deletion: { ...user.deletion, reason: null },
          lastLoginAt: null,
          purgedAt: now,
          updatedAt: now,
          version: user.version + 1,
        };
        if (!(await store.updateUser(anonymised, user.version))) {
          throw new UsersError(
            'USERS_VERSION_CONFLICT',
            'The user was modified during purge; retry',
          );
        }
        await store.deleteActivity(id);
        await store.deleteActivationTokens(id);
      }
      await store.deleteInvitationsByEmail(user.email);
      await audit('users.purged', context, {
        category: 'data',
        resource: { type: 'user', id },
        metadata: { policy },
      });
      await emit('user.purged', { userId: id, policy });
      return { purged: true, policy };
    },

    async purgeExpired(limit = 100) {
      const due = await store.listDueForPurge(clock.now(), clampLimit(limit, 100, 1000));
      const purged: string[] = [];
      const failed: string[] = [];
      const ctx: ActionContext = { actor: { id: 'system', type: 'system' } };
      for (const user of due) {
        try {
          const r = await service.purgeUser(user.id, {}, ctx);
          if (r.purged) purged.push(user.id);
        } catch (err) {
          failed.push(user.id);
          logger.error({ userId: user.id, ...errInfo(err) }, 'users purge failed');
        }
      }
      return { purged, failed };
    },

    async exportUserData(id, context = {}) {
      const user = await getUser(id);
      const events: ActivityEvent[] = [];
      let before: { at: number; id: string } | undefined;
      for (;;) {
        const q: Parameters<UsersStore['listActivity']>[1] = { limit: 500 };
        if (before) q.before = before;
        const page = await store.listActivity(id, q);
        events.push(...page);
        const last = page[page.length - 1];
        if (page.length < 500 || !last) break;
        before = { at: last.at, id: last.id };
      }
      const invitations: Invitation[] = [];
      let after: { createdAt: number; id: string } | undefined;
      for (;;) {
        const q: Parameters<UsersStore['listInvitations']>[0] = { email: user.email, limit: 200 };
        if (after) q.after = after;
        const page = await store.listInvitations(q);
        invitations.push(...page.map(publicInvitation));
        const last = page[page.length - 1];
        if (page.length < 200 || !last) break;
        after = { createdAt: last.createdAt, id: last.id };
      }
      const tokens = (await store.listActivationTokens(id)).map(
        ({ tokenHash: _h, ...rest }) => rest,
      );
      await audit('users.exported', context, { category: 'data', resource: { type: 'user', id } });
      return {
        format: 'aspec.users.export',
        version: 1,
        exportedAt: new Date(clock.now()).toISOString(),
        user,
        effectiveSettings: mergeWithDefaults(settingDefs, user.settings),
        effectivePreferences: mergeWithDefaults(preferenceDefs, user.preferences),
        invitations,
        activationTokens: tokens,
        activity: events,
      };
    },

    async recordActivity(userId, input) {
      const user = await getUser(userId);
      const type = assertActivityType(input?.type);
      const metadata = assertJsonObject(input.metadata, 'metadata', activityMetaMax);
      const at = input.at === undefined ? clock.now() : toTime('at', input.at);
      const event: ActivityEvent = {
        id: generateId(),
        userId: user.id,
        type,
        at: at as number,
        actorId: input.actorId ?? null,
        ip: input.ip?.slice(0, 100) ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        metadata,
      };
      await store.appendActivity(event);
      return event;
    },

    async recordLogin(userId, input = {}) {
      const event = await service.recordActivity(userId, {
        ...input,
        type: 'login',
        actorId: input.actorId ?? userId,
      });
      await mutate(userId, undefined, (u) => {
        u.lastLoginAt = event.at;
        return u;
      });
      return event;
    },

    async listActivity(userId, query = {}) {
      await getUser(userId);
      const limit = clampLimit(query.limit);
      const before = decodeCursor(query.cursor);
      const q: Parameters<UsersStore['listActivity']>[1] = { limit };
      if (query.type !== undefined) q.type = assertActivityType(query.type);
      if (before) q.before = { at: before.time, id: before.id };
      const rows = await store.listActivity(userId, q);
      const last = rows[rows.length - 1];
      return {
        items: rows,
        nextCursor: rows.length === limit && last ? encodeCursor(last.at, last.id) : null,
      };
    },

    async pruneActivity(opts = {}) {
      const age =
        opts.olderThanMs === undefined
          ? retention
          : positiveDuration('olderThanMs', opts.olderThanMs, retention);
      const removed = await store.pruneActivity(clock.now() - age);
      if (removed > 0) logger.info({ removed }, 'users activity pruned');
      return removed;
    },

    async runMaintenance() {
      const { purged } = await service.purgeExpired();
      const reinstated = await service.reinstateExpiredSuspensions();
      const activityPruned = await service.pruneActivity();
      return { purged: purged.length, reinstated, activityPruned };
    },

    async can(subject, permission, resource) {
      if (!options.permissions) return false;
      return options.permissions.can(subject, permission, resource);
    },
    on,
  };
  return service;
}
