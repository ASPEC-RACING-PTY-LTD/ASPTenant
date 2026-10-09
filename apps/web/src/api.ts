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
  /** Tenant permissions held in the current organisation. */
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
}> {
  return api('/api/v1/settings');
}

export async function updateSettings(name: string): Promise<void> {
  await api('/api/v1/settings', { method: 'PATCH', body: JSON.stringify({ name }) });
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
