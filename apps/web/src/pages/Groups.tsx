import { type FormEvent, useEffect, useState } from 'react';
import {
  addGroupMember,
  createGroup,
  type DirectoryGroup,
  type DirectoryGroupDetail,
  type DirectoryUser,
  deleteGroup,
  getGroup,
  listGroups,
  listUsers,
  removeGroupMember,
  updateGroup,
} from '../api.js';
import { useAuth } from '../auth.js';

type Kind = 'security' | 'distribution';

export function GroupsPage() {
  const { session } = useAuth();
  const canManage = session?.permissions.includes('groups:manage') ?? false;
  const [groups, setGroups] = useState<DirectoryGroup[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [detail, setDetail] = useState<DirectoryGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('security');
  const [description, setDescription] = useState('');
  const [groupEmail, setGroupEmail] = useState('');
  const [memberId, setMemberId] = useState('');
  const [editName, setEditName] = useState('');
  const [editKind, setEditKind] = useState<Kind>('security');
  const [editEmail, setEditEmail] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const show = (group: DirectoryGroupDetail) => {
    setDetail(group);
    setEditName(group.name);
    setEditKind(group.kind === 'distribution' ? 'distribution' : 'security');
    setEditEmail(group.email ?? '');
    setEditDescription(group.description ?? '');
  };

  const reload = async (openId: string | null = detail?.id ?? null) => {
    const [nextGroups, nextUsers] = await Promise.all([listGroups(), listUsers()]);
    setGroups(nextGroups);
    setUsers(nextUsers);
    if (openId) show(await getGroup(openId));
  };

  useEffect(() => {
    void Promise.all([listGroups(), listUsers()])
      .then(([nextGroups, nextUsers]) => {
        setGroups(nextGroups);
        setUsers(nextUsers);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load groups.');
      });
  }, []);

  const act = async (action: () => Promise<unknown>, failed: string, done?: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    }
  };

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await createGroup({
        name,
        kind,
        ...(kind === 'distribution' && groupEmail.trim() ? { email: groupEmail.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setName('');
      setDescription('');
      setGroupEmail('');
      await reload();
    }, 'Could not create the group.');
  };

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    void act(
      async () => {
        await updateGroup(detail.id, {
          name: editName.trim(),
          kind: editKind,
          description: editDescription.trim() || null,
          ...(editKind === 'distribution' ? { email: editEmail.trim() || null } : {}),
        });
        await reload(detail.id);
      },
      'Could not save the group.',
      'Group saved.',
    );
  };

  const memberIds = new Set(detail?.members.map((member) => member.userId) ?? []);

  return (
    <>
      <div className="page-header">
        <h1>Groups</h1>
        <p>
          Security groups control who may sign in to applications. Distribution groups give a team a
          shared mail address.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {canManage ? (
        <section className="panel">
          <h2>Create group</h2>
          <form className="form-grid" onSubmit={onCreate}>
            <div className="field">
              <label htmlFor="group-name">Name</label>
              <input
                id="group-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="group-kind">Kind</label>
              <select
                id="group-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as Kind)}
              >
                <option value="security">Security</option>
                <option value="distribution">Distribution</option>
              </select>
            </div>
            {kind === 'distribution' ? (
              <div className="field">
                <label htmlFor="group-email">Email address</label>
                <input
                  id="group-email"
                  type="email"
                  placeholder="team@yourdomain.com"
                  value={groupEmail}
                  onChange={(e) => setGroupEmail(e.target.value)}
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="group-desc">Description</label>
              <input
                id="group-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Create group
              </button>
            </div>
          </form>
        </section>
      ) : null}
      <section className="panel">
        <h2>Groups</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Address</th>
              <th>Members</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.id}>
                <td>{group.name}</td>
                <td>{group.kind}</td>
                <td>{group.email ?? ''}</td>
                <td>{group.memberCount}</td>
                <td className="btn-row">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() =>
                      void act(async () => show(await getGroup(group.id)), 'Could not open group.')
                    }
                  >
                    Open
                  </button>
                  {canManage ? (
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Delete the group ${group.name}?`)) return;
                        void act(async () => {
                          await deleteGroup(group.id);
                          if (detail?.id === group.id) setDetail(null);
                          await reload(detail?.id === group.id ? null : (detail?.id ?? null));
                        }, 'Delete failed.');
                      }}
                    >
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {detail ? (
        <section className="panel">
          <h2>{detail.name}</h2>
          {canManage ? (
            <form className="form-grid" onSubmit={onSave}>
              <div className="field">
                <label htmlFor="edit-group-name">Name</label>
                <input
                  id="edit-group-name"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="edit-group-kind">Kind</label>
                <select
                  id="edit-group-kind"
                  value={editKind}
                  onChange={(e) => setEditKind(e.target.value as Kind)}
                >
                  <option value="security">Security</option>
                  <option value="distribution">Distribution</option>
                </select>
              </div>
              {editKind === 'distribution' ? (
                <div className="field">
                  <label htmlFor="edit-group-email">Email address</label>
                  <input
                    id="edit-group-email"
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                  />
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="edit-group-desc">Description</label>
                <input
                  id="edit-group-desc"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              </div>
              <div className="field field-action">
                <button className="btn" type="submit">
                  Save group
                </button>
              </div>
            </form>
          ) : (
            <p>{detail.description || 'No description.'}</p>
          )}
          {canManage && editKind === 'security' && detail.email ? (
            <p className="muted">Saving as a security group removes its mail address.</p>
          ) : null}
          {canManage ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="add-member">Add member</label>
                <select
                  id="add-member"
                  value={memberId}
                  onChange={(e) => setMemberId(e.target.value)}
                >
                  <option value="">Select a user</option>
                  {users
                    .filter((user) => !memberIds.has(user.id))
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName ?? user.email}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field field-action">
                <button
                  className="btn"
                  type="button"
                  disabled={!memberId}
                  onClick={() =>
                    void act(async () => {
                      await addGroupMember(detail.id, memberId);
                      setMemberId('');
                      await reload(detail.id);
                    }, 'Could not add member.')
                  }
                >
                  Add
                </button>
              </div>
            </div>
          ) : null}
          <table className="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.members.map((member) => (
                <tr key={member.userId}>
                  <td>{member.displayName ?? member.email ?? member.userId}</td>
                  <td>
                    {canManage ? (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() =>
                          void act(async () => {
                            await removeGroupMember(detail.id, member.userId);
                            await reload(detail.id);
                          }, 'Remove failed.')
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
