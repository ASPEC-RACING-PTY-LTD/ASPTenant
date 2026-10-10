import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  addTenantMember,
  archiveTenant,
  createTenant,
  getTenant,
  listTenants,
  restoreTenant,
  setTenantLimits,
  type TenantDetail,
  type TenantRole,
  type TenantSummary,
} from '../api.js';
import { useAuth } from '../auth.js';

type RoleChoice = 'member' | TenantRole;

function workersLabel(workers: number): string {
  return workers === 0 ? 'Paused' : String(workers);
}

function memberRoleLabel(member: TenantDetail['members'][number]): string {
  if (member.role === 'owner') return 'Owner';
  if (member.roles.includes('tenant.admin')) return 'Administrator';
  if (member.roles.includes('tenant.auditor')) return 'Auditor';
  return 'Member';
}

export function TenantsPage() {
  const { session, refresh, selectTenant } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerMode, setOwnerMode] = useState<'me' | 'other'>('me');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');

  const [memberEmail, setMemberEmail] = useState('');
  const [memberPassword, setMemberPassword] = useState('');
  const [memberRole, setMemberRoleChoice] = useState<RoleChoice>('member');
  const [importWorkers, setImportWorkers] = useState('1');
  const canOpenMailboxes = session?.permissions.includes('mailboxes:access') ?? false;

  const open = (next: TenantDetail) => {
    setDetail(next);
    setImportWorkers(String(next.limits.importWorkers));
  };

  const fail = (fallback: string) => (err: unknown) => {
    setError(err instanceof Error ? err.message : fallback);
  };

  const reload = async (openId?: string) => {
    setTenants(await listTenants());
    const id = openId ?? detail?.id;
    if (id) open(await getTenant(id));
  };

  useEffect(() => {
    void listTenants()
      .then(setTenants)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load tenants.');
      });
  }, []);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const created = await createTenant({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(ownerMode === 'other'
          ? {
              owner: {
                email: ownerEmail.trim(),
                ...(ownerName.trim() ? { displayName: ownerName.trim() } : {}),
                ...(ownerPassword ? { password: ownerPassword } : {}),
              },
            }
          : {}),
      });
      setName('');
      setSlug('');
      setOwnerEmail('');
      setOwnerName('');
      setOwnerPassword('');
      setNotice(`${created.name} was created.`);
      await reload(created.id);
      await refresh();
    } catch (err) {
      fail('Could not create the tenant.')(err);
    }
  };

  const onAddMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setError(null);
    setNotice(null);
    try {
      await addTenantMember(detail.id, {
        email: memberEmail.trim(),
        role: memberRole === 'member' ? null : memberRole,
        ...(memberPassword ? { password: memberPassword } : {}),
      });
      setMemberEmail('');
      setMemberPassword('');
      setNotice(`${memberEmail.trim()} was added to ${detail.name}.`);
      await reload();
      await refresh();
    } catch (err) {
      fail('Could not add the member.')(err);
    }
  };

  const onSaveLimits = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setError(null);
    setNotice(null);
    try {
      const limits = await setTenantLimits(detail.id, { importWorkers: Number(importWorkers) });
      setNotice(
        limits.importWorkers === 0
          ? `Imports for ${detail.name} are paused.`
          : `${detail.name} can now run ${limits.importWorkers} import${limits.importWorkers === 1 ? '' : 's'} at once.`,
      );
      await reload();
    } catch (err) {
      fail('Could not save the limits.')(err);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Tenants</h1>
        <p>
          Each tenant is a separate organisation with its own users, roles, groups, domains,
          mailboxes, applications and audit history. Operating the installation does not grant
          access to a tenant's data, with one exception: operators can open any tenant's mailboxes
          from the Mailbox page, and every use is recorded in that tenant's audit log. Join a tenant
          as a member to administer it.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <section className="panel">
        <h2>Create tenant</h2>
        <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
          <div className="field">
            <label htmlFor="tenant-name">Organisation name</label>
            <input
              id="tenant-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="tenant-slug">Slug (optional)</label>
            <input
              id="tenant-slug"
              placeholder="derived from the name"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="tenant-owner">Owner</label>
            <select
              id="tenant-owner"
              value={ownerMode}
              onChange={(e) => setOwnerMode(e.target.value as 'me' | 'other')}
            >
              <option value="me">Me ({session?.user.email})</option>
              <option value="other">Another account</option>
            </select>
          </div>
          {ownerMode === 'other' ? (
            <>
              <div className="field">
                <label htmlFor="owner-email">Owner email</label>
                <input
                  id="owner-email"
                  type="email"
                  required
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="owner-name">Owner display name</label>
                <input
                  id="owner-name"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="owner-password">Password for a new account</label>
                <input
                  id="owner-password"
                  type="password"
                  minLength={12}
                  placeholder="leave empty for an existing account"
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                />
              </div>
            </>
          ) : null}
          <div className="field field-action">
            <button className="btn" type="submit">
              Create tenant
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>All tenants</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Status</th>
              <th>Active members</th>
              <th>Import workers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>
                  {tenant.name}
                  {tenant.id === session?.organisation?.id ? ' (current)' : ''}
                </td>
                <td>{tenant.slug}</td>
                <td>
                  <span
                    className={`badge ${tenant.status === 'active' ? 'badge-ok' : 'badge-warn'}`}
                  >
                    {tenant.status}
                  </span>
                </td>
                <td>{tenant.members}</td>
                <td>{workersLabel(tenant.limits.importWorkers)}</td>
                <td className="btn-row">
                  {tenant.status === 'active' && (tenant.joined || canOpenMailboxes) ? (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        void selectTenant(tenant.id).then(() =>
                          navigate(tenant.joined ? '/' : '/mailbox'),
                        );
                      }}
                    >
                      {tenant.joined ? 'Open' : 'Open mailboxes'}
                    </button>
                  ) : null}
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => {
                      void getTenant(tenant.id).then(open).catch(fail('Could not load.'));
                    }}
                  >
                    Manage
                  </button>
                  {tenant.status === 'active' ? (
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => {
                        void archiveTenant(tenant.id)
                          .then(() => reload())
                          .then(refresh)
                          .catch(fail('Archive failed.'));
                      }}
                    >
                      Archive
                    </button>
                  ) : (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        void restoreTenant(tenant.id)
                          .then(() => reload())
                          .then(refresh)
                          .catch(fail('Restore failed.'));
                      }}
                    >
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {detail ? (
        <section className="panel">
          <h2>{detail.name}</h2>
          <h3>Limits</h3>
          <p>
            Import workers is how many mailbox imports this tenant can run at the same time. Its
            other imports wait in the queue until a worker is free. Set 0 to pause its imports. All
            workers share this server's CPU and disk, so raise it only as far as the server can
            handle alongside the other tenants.
          </p>
          <form className="form-grid" onSubmit={(event) => void onSaveLimits(event)}>
            <div className="field">
              <label htmlFor="limit-import-workers">Import workers</label>
              <input
                id="limit-import-workers"
                type="number"
                min={0}
                max={16}
                required
                value={importWorkers}
                onChange={(e) => setImportWorkers(e.target.value)}
              />
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Save limits
              </button>
            </div>
          </form>
          <h3>Members</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {detail.members.map((member) => (
                <tr key={member.userId}>
                  <td>
                    {member.email ?? member.userId}
                    {member.displayName ? ` (${member.displayName})` : ''}
                  </td>
                  <td>{memberRoleLabel(member)}</td>
                  <td>{member.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.status === 'active' ? (
            <form className="form-grid" onSubmit={(event) => void onAddMember(event)}>
              <div className="field">
                <label htmlFor="member-email">Account email</label>
                <input
                  id="member-email"
                  type="email"
                  required
                  value={memberEmail}
                  onChange={(e) => setMemberEmail(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="member-password">Password for a new account</label>
                <input
                  id="member-password"
                  type="password"
                  minLength={12}
                  placeholder="leave empty for an existing account"
                  value={memberPassword}
                  onChange={(e) => setMemberPassword(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="member-role">Role</label>
                <select
                  id="member-role"
                  value={memberRole}
                  onChange={(e) => setMemberRoleChoice(e.target.value as RoleChoice)}
                >
                  <option value="member">Member</option>
                  <option value="tenant.admin">Administrator</option>
                  <option value="tenant.auditor">Auditor</option>
                </select>
              </div>
              <div className="field field-action">
                <button className="btn" type="submit">
                  Add member
                </button>
              </div>
            </form>
          ) : (
            <p>Restore this tenant before adding members.</p>
          )}
        </section>
      ) : null}
    </>
  );
}
