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
} from '../api.js';

export function GroupsPage() {
  const [groups, setGroups] = useState<DirectoryGroup[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [detail, setDetail] = useState<DirectoryGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'security' | 'distribution'>('security');
  const [description, setDescription] = useState('');
  const [groupEmail, setGroupEmail] = useState('');
  const [memberId, setMemberId] = useState('');

  const reload = async () => {
    const [nextGroups, nextUsers] = await Promise.all([listGroups(), listUsers()]);
    setGroups(nextGroups);
    setUsers(nextUsers);
    if (detail) setDetail(await getGroup(detail.id));
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

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await createGroup({
        name,
        kind,
        ...(kind === 'distribution' && groupEmail.trim() ? { email: groupEmail.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setName('');
      setDescription('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the group.');
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Groups</h1>
        <p>
          Security groups control access later. Distribution groups are for mail addressing later.
        </p>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="panel">
        <h2>Create group</h2>
        <form className="form-grid" onSubmit={(event) => void onCreate(event)}>
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
              onChange={(e) => setKind(e.target.value as 'security' | 'distribution')}
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
                    onClick={() => {
                      void getGroup(group.id)
                        .then(setDetail)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Could not open group.');
                        });
                    }}
                  >
                    Open
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => {
                      void deleteGroup(group.id)
                        .then(() => {
                          if (detail?.id === group.id) setDetail(null);
                          return reload();
                        })
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Delete failed.');
                        });
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {detail ? (
        <section className="panel">
          <h2>{detail.name}</h2>
          <p>{detail.description || 'No description.'}</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="add-member">Add member</label>
              <select
                id="add-member"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
              >
                <option value="">Select a user</option>
                {users.map((user) => (
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
                onClick={() => {
                  void addGroupMember(detail.id, memberId)
                    .then(reload)
                    .catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : 'Could not add member.');
                    });
                }}
              >
                Add
              </button>
            </div>
          </div>
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
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => {
                        void removeGroupMember(detail.id, member.userId)
                          .then(reload)
                          .catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : 'Remove failed.');
                          });
                      }}
                    >
                      Remove
                    </button>
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
