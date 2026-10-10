export interface SetupState {
  required: boolean;
}

export interface PlatformInfo {
  name: string;
  product: string;
  version: string;
  setupRequired: boolean;
  tenantMode: string;
  capabilities: Record<string, { implemented: boolean; ownsMailboxes?: boolean; notes?: string[] }>;
  mailTransports: Array<{
    kind: string;
    direction: string;
    status: string;
    title: string;
    summary: string;
  }>;
}

export interface TenantRef {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface SessionInfo {
  account: { id: string; email: string; emailVerified: boolean; mfaEnabled: boolean };
  user: { id: string; email: string; displayName: string | null; status: string };
  /** Organisation this session is working in. Null when the account belongs to none. */
  organisation: { id: string; name: string; slug: string; status: string } | null;
  membership: { role: string; status: string } | null;
  /** Tenant roles held in the current organisation. */
  roles: string[];
  /** Tenant permissions in the current organisation plus platform permissions. */
  permissions: string[];
  tenants: TenantRef[];
  platform: { operator: boolean; permissions: string[] };
}

export interface HealthReport {
  status: string;
  checks?: Record<string, { status: string; latencyMs?: number }>;
}

export interface DirectoryUser {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  createdAt: number;
  lastLoginAt: number | null;
  membershipStatus: string;
  orgRole: string | null;
  roles: string[];
  mailboxId?: string | null;
}

export type TenantRole = 'tenant.admin' | 'tenant.auditor';

export interface DirectoryGroup {
  id: string;
  email: string | null;
  name: string;
  slug: string;
  kind: string;
  description: string | null;
  memberCount: number;
}

export interface DirectoryGroupDetail extends DirectoryGroup {
  members: Array<{
    userId: string;
    email: string | null;
    displayName: string | null;
    addedAt: number;
  }>;
}

export interface AuditEvent {
  id: string;
  time: string;
  timestamp: number;
  action: string;
  outcome: string;
  category: string;
  actor: { id: string; type?: string; ip?: string } | null;
  resource: { type: string; id?: string } | null;
}

export interface DirectoryDomain {
  id: string;
  hostname: string;
  status: string;
  primary: boolean;
  createdAt: number;
  verifiedAt: number | null;
  verification: { type: 'TXT'; name: string; value: string } | null;
}

export interface DirectoryMailbox {
  id: string;
  userId: string | null;
  primaryAddress: string;
  kind: string;
  displayName: string | null;
  aliases: string[];
}

export interface DirectoryApplication {
  id: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  createdAt: number;
}

export interface SystemDiagnostics {
  uptimeMs: number;
  database: { ok: boolean; latencyMs: number | null; dialect: string };
  isolation?: {
    tenantId: string;
    rowLevelSecurity: { policies: boolean; enforced: boolean; detail: string };
  };
  counts: {
    users: number;
    groups: number;
    domains: number;
    mailboxes: number;
    applications: number;
    auditEvents: number;
  };
}

export interface AuthSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  current?: boolean;
}

export interface SecurityRole {
  key: string;
  name: string;
  description: string | null;
  scope?: 'platform' | 'organisation';
  permissions: string[];
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: number;
  members: number;
  joined: boolean;
}

export interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  members: Array<{
    userId: string;
    email: string | null;
    displayName: string | null;
    role: string;
    status: string;
    roles: string[];
  }>;
}

const TENANT_KEY = 'aspectenant.tenant';
let selectedTenant: string | null = readStoredTenant();

function readStoredTenant(): string | null {
  try {
    return globalThis.localStorage?.getItem(TENANT_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Organisation the admin UI works in. Sent with every API request. */
export function getSelectedTenant(): string | null {
  return selectedTenant;
}

export function setSelectedTenant(id: string | null): void {
  selectedTenant = id;
  try {
    if (id) globalThis.localStorage?.setItem(TENANT_KEY, id);
    else globalThis.localStorage?.removeItem(TENANT_KEY);
  } catch {
    // Storage can be unavailable (private mode). The selection still lasts for this page.
  }
}

function withTenant(headers: Headers): Headers {
  if (selectedTenant && !headers.has('x-aspectenant-tenant')) {
    headers.set('x-aspectenant-tenant', selectedTenant);
  }
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function problem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; title?: string };
    return body.detail || body.title || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = withTenant(new Headers(init.headers));
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { credentials: 'include', ...init, headers });
  if (!response.ok) throw new Error(await problem(response));
  if (response.status === 204) return undefined as T;
  return readJson<T>(response);
}

export async function getPlatform(): Promise<PlatformInfo> {
  return api('/api/v1/platform');
}

export async function getSetupState(): Promise<SetupState> {
  return api('/api/v1/setup');
}

export async function completeSetup(input: {
  email: string;
  password: string;
  setupCode: string;
  displayName?: string;
  organisationName?: string;
}): Promise<void> {
  await api('/api/v1/setup', { method: 'POST', body: JSON.stringify(input) });
}

export async function login(email: string, password: string): Promise<void> {
  const body = await api<{ status?: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (body.status !== 'authenticated') {
    throw new Error('Sign-in did not complete. Multifactor is not enabled.');
  }
}

export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
}

export async function getSession(): Promise<SessionInfo | null> {
  const response = await fetch('/api/v1/session', {
    credentials: 'include',
    headers: withTenant(new Headers()),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await problem(response));
  return readJson(response);
}

export async function getReadiness(): Promise<HealthReport> {
  return readJson(await fetch('/readyz', { credentials: 'include' }));
}

export async function listUsers(): Promise<DirectoryUser[]> {
  const body = await api<{ items: DirectoryUser[] }>('/api/v1/users');
  return body.items;
}

export async function createUser(input: {
  email: string;
  password: string;
  displayName?: string;
  role: TenantRole | null;
}): Promise<{ mailboxId: string | null }> {
  return api('/api/v1/users', { method: 'POST', body: JSON.stringify(input) });
}

export async function setUserRole(id: string, role: TenantRole | null): Promise<void> {
  await api(`/api/v1/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
}

export async function removeUser(id: string): Promise<void> {
  await api(`/api/v1/users/${id}`, { method: 'DELETE' });
}

export async function updateUser(id: string, displayName: string | null): Promise<void> {
  await api(`/api/v1/users/${id}`, { method: 'PATCH', body: JSON.stringify({ displayName }) });
}

export async function suspendUser(id: string, reason: string): Promise<void> {
  await api(`/api/v1/users/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function reinstateUser(id: string): Promise<void> {
  await api(`/api/v1/users/${id}/reinstate`, { method: 'POST' });
}

export async function listGroups(): Promise<DirectoryGroup[]> {
  const body = await api<{ items: DirectoryGroup[] }>('/api/v1/groups');
  return body.items;
}

export async function getGroup(id: string): Promise<DirectoryGroupDetail> {
  return api(`/api/v1/groups/${id}`);
}

export async function createGroup(input: {
  email?: string;
  name: string;
  kind: 'security' | 'distribution';
  description?: string;
}): Promise<void> {
  await api('/api/v1/groups', { method: 'POST', body: JSON.stringify(input) });
}

export async function deleteGroup(id: string): Promise<void> {
  await api(`/api/v1/groups/${id}`, { method: 'DELETE' });
}

export async function addGroupMember(groupId: string, userId: string): Promise<void> {
  await api(`/api/v1/groups/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await api(`/api/v1/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
}

export async function listAudit(query: {
  actionPrefix?: string;
  category?: string;
  limit?: number;
}): Promise<AuditEvent[]> {
  const params = new URLSearchParams();
  if (query.actionPrefix) params.set('actionPrefix', query.actionPrefix);
  if (query.category) params.set('category', query.category);
  if (query.limit) params.set('limit', String(query.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const body = await api<{ items: AuditEvent[] }>(`/api/v1/audit${suffix}`);
  return body.items;
}

export async function getSettings(): Promise<{
  organisation: { id: string; name: string; slug: string; status: string };
  tenantMode: string;
  publicUrl: string | null;
}> {
  return api('/api/v1/settings');
}

export async function updateSettings(
  name: string,
  publicUrl: string | null,
): Promise<{ restarting: boolean; publicUrl: string | null }> {
  return api('/api/v1/settings', { method: 'PATCH', body: JSON.stringify({ name, publicUrl }) });
}

export async function listAuthSessions(): Promise<AuthSession[]> {
  const body = await api<{ sessions: AuthSession[] }>('/auth/sessions');
  return body.sessions;
}

export async function revokeAuthSession(id: string): Promise<void> {
  await api(`/auth/sessions/${id}`, { method: 'DELETE' });
}

export async function revokeOtherAuthSessions(): Promise<void> {
  await api('/auth/sessions', { method: 'DELETE' });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api('/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function listRoles(): Promise<SecurityRole[]> {
  const body = await api<{ items: SecurityRole[] }>('/api/v1/security/roles');
  return body.items;
}

export async function listDomains(): Promise<{
  items: DirectoryDomain[];
  canOverride: boolean;
}> {
  return api('/api/v1/domains');
}

export async function createDomain(hostname: string): Promise<void> {
  await api('/api/v1/domains', { method: 'POST', body: JSON.stringify({ hostname }) });
}

export async function verifyDomain(id: string): Promise<void> {
  await api(`/api/v1/domains/${id}/verify`, { method: 'POST' });
}

export async function confirmDomain(id: string): Promise<void> {
  await api(`/api/v1/domains/${id}/confirm`, { method: 'POST' });
}

export async function setPrimaryDomain(id: string): Promise<void> {
  await api(`/api/v1/domains/${id}/primary`, { method: 'POST' });
}

export async function deleteDomain(id: string): Promise<void> {
  await api(`/api/v1/domains/${id}`, { method: 'DELETE' });
}

export async function listMailboxes(): Promise<DirectoryMailbox[]> {
  const body = await api<{ items: DirectoryMailbox[] }>('/api/v1/mailboxes');
  return body.items;
}

export async function createMailbox(input: {
  kind: 'user' | 'shared';
  primaryAddress: string;
  userId?: string;
  displayName?: string;
}): Promise<void> {
  await api('/api/v1/mailboxes', { method: 'POST', body: JSON.stringify(input) });
}

export async function deleteMailbox(id: string): Promise<void> {
  await api(`/api/v1/mailboxes/${id}`, { method: 'DELETE' });
}

export async function addMailboxAlias(id: string, alias: string): Promise<void> {
  await api(`/api/v1/mailboxes/${id}/aliases`, { method: 'POST', body: JSON.stringify({ alias }) });
}

export async function removeMailboxAlias(id: string, alias: string): Promise<void> {
  await api(`/api/v1/mailboxes/${id}/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' });
}

export async function listApplications(): Promise<DirectoryApplication[]> {
  const body = await api<{ items: DirectoryApplication[] }>('/api/v1/applications');
  return body.items;
}

export async function createApplication(name: string, redirectUris: string[]): Promise<void> {
  await api('/api/v1/applications', {
    method: 'POST',
    body: JSON.stringify({ name, redirectUris }),
  });
}

export async function deleteApplication(id: string): Promise<void> {
  await api(`/api/v1/applications/${id}`, { method: 'DELETE' });
}

export async function getSystem(): Promise<SystemDiagnostics> {
  return api('/api/v1/system');
}

export async function listTenants(): Promise<TenantSummary[]> {
  const body = await api<{ items: TenantSummary[] }>('/api/v1/tenants');
  return body.items;
}

export async function getTenant(id: string): Promise<TenantDetail> {
  return api(`/api/v1/tenants/${id}`);
}

export interface AccountInput {
  email: string;
  password?: string;
  displayName?: string;
}

export async function createTenant(input: {
  name: string;
  slug?: string;
  owner?: AccountInput;
}): Promise<TenantSummary> {
  return api('/api/v1/tenants', { method: 'POST', body: JSON.stringify(input) });
}

export async function addTenantMember(
  tenantId: string,
  input: AccountInput & { role: TenantRole | null },
): Promise<void> {
  await api(`/api/v1/tenants/${tenantId}/members`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function archiveTenant(id: string): Promise<void> {
  await api(`/api/v1/tenants/${id}/archive`, { method: 'POST' });
}

export async function restoreTenant(id: string): Promise<void> {
  await api(`/api/v1/tenants/${id}/restore`, { method: 'POST' });
}

export interface MailAddress {
  address: string;
  name: string | null;
}

export interface MailFolderInfo {
  name: string;
  specialUse: string | null;
  total: number;
  unread: number;
}

export interface MyMailbox extends DirectoryMailbox {
  folders: MailFolderInfo[];
}

export interface MessageSummary {
  id: string;
  mailboxId: string;
  folder: string;
  messageId: string | null;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: number | null;
  receivedAt: number;
  sizeBytes: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  snippet: string;
}

export interface MessageDetail extends MessageSummary {
  replyTo: MailAddress[];
  references: string[];
  text: string;
  html: string | null;
  attachments: Array<{ index: number; filename: string; contentType: string; size: number }>;
}

export interface SendInput {
  mailboxId: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ filename: string; contentType?: string; contentBase64: string }>;
}

export interface MailSettings {
  outbound: {
    kind: 'none' | 'cloudflare' | 'smtp';
    cloudflare: { hasToken: boolean };
    smtp: {
      host: string;
      port: number;
      security: 'tls' | 'starttls' | 'none';
      username: string | null;
      hasPassword: boolean;
    };
  };
  ingest: { configured: boolean; url: string };
  workerScript: string;
}

export interface DomainDns {
  verification: { name: string; value: string; found: boolean };
  mx: Array<{ exchange: string; priority: number }>;
  mxOnCloudflare: boolean;
  spf: string | null;
  spfIncludesCloudflare: boolean;
  dmarc: string | null;
}

export interface UpdateStatus {
  current: string;
  repository: string;
  autoUpdate: boolean;
  latest: { version: string; url: string; publishedAt: string | null; notes: string } | null;
  checkedAt: number | null;
  lastError: string | null;
  updateAvailable: boolean;
  updater: {
    available: boolean;
    pending: boolean;
    state: string | null;
    finishedAt: number | null;
    log: string | null;
  };
}

export async function myMailboxes(): Promise<MyMailbox[]> {
  return (await api<{ items: MyMailbox[] }>('/api/v1/mail/me')).items;
}

export async function listMessages(
  mailboxId: string,
  folder: string,
  search?: string,
): Promise<MessageSummary[]> {
  const params = new URLSearchParams({ folder });
  if (search) params.set('search', search);
  return (
    await api<{ items: MessageSummary[] }>(`/api/v1/mail/mailboxes/${mailboxId}/messages?${params}`)
  ).items;
}

export async function getMessage(id: string): Promise<MessageDetail> {
  return api(`/api/v1/mail/messages/${id}`);
}

export async function updateMessage(
  id: string,
  patch: { seen?: boolean; flagged?: boolean; folder?: string },
): Promise<void> {
  await api(`/api/v1/mail/messages/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteMessage(id: string): Promise<void> {
  await api(`/api/v1/mail/messages/${id}`, { method: 'DELETE' });
}

export async function emptyFolder(mailboxId: string, folder: string): Promise<void> {
  await api(`/api/v1/mail/mailboxes/${mailboxId}/empty?folder=${folder}`, { method: 'POST' });
}

export async function sendMessage(input: SendInput): Promise<void> {
  await api('/api/v1/mail/send', { method: 'POST', body: JSON.stringify(input) });
}

export async function getMailSettings(): Promise<MailSettings> {
  return api('/api/v1/mail/settings');
}

export async function saveMailSettings(input: {
  kind: string;
  cloudflareToken?: string;
  smtp?: {
    host: string;
    port: number;
    security: string;
    username?: string | null;
    password?: string;
  };
}): Promise<MailSettings> {
  return api('/api/v1/mail/settings', { method: 'PUT', body: JSON.stringify(input) });
}

export async function testMailSettings(to?: string): Promise<{ detail: string }> {
  return api('/api/v1/mail/settings/test', {
    method: 'POST',
    body: JSON.stringify(to ? { to } : {}),
  });
}

export async function rotateIngestToken(): Promise<string> {
  return (await api<{ token: string }>('/api/v1/mail/settings/ingest-token', { method: 'POST' }))
    .token;
}

export async function listMailboxMembers(
  id: string,
): Promise<Array<{ userId: string; email: string | null; displayName: string | null }>> {
  return (
    await api<{
      items: Array<{ userId: string; email: string | null; displayName: string | null }>;
    }>(`/api/v1/mail/admin/mailboxes/${id}/members`)
  ).items;
}

export async function addMailboxMember(id: string, userId: string): Promise<void> {
  await api(`/api/v1/mail/admin/mailboxes/${id}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export async function removeMailboxMember(id: string, userId: string): Promise<void> {
  await api(`/api/v1/mail/admin/mailboxes/${id}/members/${userId}`, { method: 'DELETE' });
}

export async function getDomainDns(id: string): Promise<DomainDns> {
  return api(`/api/v1/domains/${id}/dns`);
}

export async function getUpdates(): Promise<UpdateStatus> {
  return api('/api/v1/updates');
}

export async function checkUpdates(): Promise<UpdateStatus> {
  return api('/api/v1/updates/check', { method: 'POST' });
}

export async function applyUpdate(): Promise<UpdateStatus> {
  return api('/api/v1/updates/apply', { method: 'POST' });
}

export async function setAutoUpdate(autoUpdate: boolean): Promise<UpdateStatus> {
  return api('/api/v1/updates/settings', { method: 'PUT', body: JSON.stringify({ autoUpdate }) });
}

export interface MailClientSettings {
  enabled: boolean;
  hostname: string;
  certMode: 'acme' | 'manual';
  acmeEmail: string | null;
  hasDnsToken: boolean;
  hasCertificate: boolean;
  certExpiresAt: number | null;
  lastError: string | null;
  running: boolean;
  problem: string | null;
  certificateSource: 'panel' | 'data-volume' | null;
  cloudflareConnected: boolean;
  listeners: Array<{
    name: string;
    protocol: string;
    port: number;
    state: 'stopped' | 'listening' | 'failed';
    accepting: boolean;
    error: string | null;
    code: string | null;
  }>;
  ports: { imaps: number; smtps: number; submission: number };
}

export async function getMailClients(): Promise<MailClientSettings> {
  return api('/api/v1/mail/clients');
}

export async function saveMailClients(input: {
  enabled: boolean;
  hostname: string;
  certMode: 'acme' | 'manual';
  acmeEmail?: string | null;
  cloudflareDnsToken?: string;
  certPem?: string;
  keyPem?: string;
}): Promise<MailClientSettings> {
  return api('/api/v1/mail/clients', { method: 'PUT', body: JSON.stringify(input) });
}

export async function issueMailCertificate(): Promise<MailClientSettings> {
  return api('/api/v1/mail/clients/certificate', { method: 'POST' });
}

export interface JobInfo<D = Record<string, unknown>, P = Record<string, unknown>> {
  id: string;
  kind: string;
  status: string;
  title: string;
  data: D;
  progress: P;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type ImportJob = JobInfo<
  { mailboxId: string; filename: string; size: number; received: number },
  {
    total: number;
    processed: number;
    imported: number;
    skipped: number;
    failed: number;
    folder: string | null;
  }
>;

export async function listImports(): Promise<ImportJob[]> {
  return (await api<{ items: ImportJob[] }>('/api/v1/imports')).items;
}

export async function createImport(input: {
  mailboxId: string;
  filename: string;
  size: number;
}): Promise<ImportJob> {
  return api('/api/v1/imports', { method: 'POST', body: JSON.stringify(input) });
}

export async function uploadImportChunk(
  id: string,
  offset: number,
  chunk: Blob | ArrayBuffer,
): Promise<ImportJob> {
  return api(`/api/v1/imports/${id}/chunk?offset=${offset}`, {
    method: 'PUT',
    body: chunk,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

export async function retryImport(id: string): Promise<void> {
  await api(`/api/v1/imports/${id}/retry`, { method: 'POST' });
}

export async function deleteImport(id: string): Promise<void> {
  await api(`/api/v1/imports/${id}`, { method: 'DELETE' });
}

export interface BackupSettings {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  intervalHours: number;
  retentionCount: number;
  hasSecret: boolean;
  hasPassphrase: boolean;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
}

export type BackupJob = JobInfo<
  { key: string | null; trigger: string },
  { tables: number; rows: number; bytes: number }
>;

export async function getBackups(): Promise<{ settings: BackupSettings; history: BackupJob[] }> {
  return api('/api/v1/backups');
}

export async function saveBackupSettings(
  input: Omit<BackupSettings, 'hasSecret' | 'hasPassphrase' | 'lastSuccessAt' | 'nextRunAt'> & {
    secretAccessKey?: string;
    passphrase?: string;
  },
): Promise<BackupSettings> {
  return api('/api/v1/backups/settings', { method: 'PUT', body: JSON.stringify(input) });
}

export async function testBackups(): Promise<{ detail: string }> {
  return api('/api/v1/backups/test', { method: 'POST' });
}

export async function runBackup(): Promise<BackupJob> {
  return api('/api/v1/backups/run', { method: 'POST' });
}

export async function listRemoteBackups(): Promise<
  Array<{ key: string; size: number; modifiedAt: number }>
> {
  return (
    await api<{ items: Array<{ key: string; size: number; modifiedAt: number }> }>(
      '/api/v1/backups/remote',
    )
  ).items;
}

export async function restoreBackup(key: string): Promise<{ tables: number; rows: number }> {
  return api('/api/v1/backups/restore', {
    method: 'POST',
    body: JSON.stringify({ key, confirm: 'RESTORE' }),
  });
}

export async function setupRestore(input: {
  setupCode: string;
  passphrase: string;
  key?: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
}): Promise<{ key: string; tables: number; rows: number }> {
  return api('/api/v1/setup/restore', { method: 'POST', body: JSON.stringify(input) });
}

export interface RequiredRecord {
  key: string;
  purpose: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  status: 'ok' | 'missing' | 'different';
  found: string[];
  automatic: boolean;
}

export interface DomainSetup {
  domain: DirectoryDomain;
  provider: { id: string; name: string; nameservers: string[] };
  cloudflare: { connected: boolean; zone: boolean };
  verification: { name: string; value: string; found: boolean };
  records: RequiredRecord[];
  manualSteps: string[];
}

export async function getDomainSetup(id: string): Promise<DomainSetup> {
  return api(`/api/v1/domains/${id}/setup`);
}

export async function connectCloudflare(token: string): Promise<{ zones: string[] }> {
  return api('/api/v1/integrations/cloudflare', { method: 'PUT', body: JSON.stringify({ token }) });
}

export async function verifyDomainWithCloudflare(id: string): Promise<void> {
  await api(`/api/v1/domains/${id}/verify/cloudflare`, { method: 'POST' });
}

export async function applyDomainRecords(
  id: string,
): Promise<{ created: string[]; skipped: string[] }> {
  return api(`/api/v1/domains/${id}/records/apply`, { method: 'POST' });
}

export interface DomainConnectSettings {
  configured: boolean;
  providerId: string;
  serviceId: string;
  keyId: string;
  publicKey: string | null;
  publicKeyTxt: string | null;
}

export async function getDomainConnect(): Promise<DomainConnectSettings> {
  return api('/api/v1/integrations/domain-connect');
}

export async function saveDomainConnect(input: {
  providerId: string;
  serviceId: string;
  keyId: string;
  privateKey?: string;
  generateKey?: boolean;
}): Promise<DomainConnectSettings> {
  return api('/api/v1/integrations/domain-connect', { method: 'PUT', body: JSON.stringify(input) });
}

export async function startDomainConnect(
  id: string,
): Promise<
  | { supported: true; providerName: string; applyUrl: string }
  | { supported: false; providerName: string | null; reason: string }
> {
  return api(`/api/v1/domains/${id}/domain-connect`, { method: 'POST' });
}
