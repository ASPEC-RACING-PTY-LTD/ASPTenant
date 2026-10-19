import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  addMailboxAlias,
  addMailboxMember,
  createMailbox,
  type DirectoryMailbox,
  type DirectoryUser,
  deleteMailbox,
  listMailboxes,
  listMailboxMembers,
  listUsers,
  removeMailboxAlias,
  removeMailboxMember,
  updateMailbox,
} from '../api.js';
import { useAuth } from '../auth.js';

type Member = { userId: string; email: string | null; displayName: string | null };

export function MailPage() {
  const { session } = useAuth();
  const canManage = session?.permissions.includes('mail:manage') ?? false;
  const iAmOwner = session?.membership?.role === 'owner';
  const [mailboxes, setMailboxes] = useState<DirectoryMailbox[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<'shared' | 'user'>('shared');
  const [userId, setUserId] = useState('');
  const [alias, setAlias] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberId, setMemberId] = useState('');
  const [editName, setEditName] = useState('');
  const [editAddress, setEditAddress] = useState('');

  useEffect(() => {
    // Clear the previous mailbox's delegates so they never show under another mailbox.
    setMembers([]);
    setMemberId('');
    if (!selectedId) return;
    void listMailboxMembers(selectedId)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [selectedId]);

  const reload = async () => {
    const [nextMailboxes, nextUsers] = await Promise.all([listMailboxes(), listUsers()]);
    setMailboxes(nextMailboxes);
    setUsers(nextUsers);
    return nextMailboxes;
  };

  useEffect(() => {
    void Promise.all([listMailboxes(), listUsers()])
      .then(([nextMailboxes, nextUsers]) => {
        setMailboxes(nextMailboxes);
        setUsers(nextUsers);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load mailboxes.');
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

  const select = (mailbox: DirectoryMailbox) => {
    setSelectedId(mailbox.id);
    setEditName(mailbox.displayName ?? '');
    setEditAddress(mailbox.primaryAddress);
  };

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await createMailbox({
        kind,
        primaryAddress: address,
        ...(kind === 'user' && userId ? { userId } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      setAddress('');
      setDisplayName('');
      setUserId('');
      await reload();
    }, 'Could not create the mailbox.');
  };

  const ownerIds = new Set(
    users
      .filter((user) => user.orgRole === 'owner' || user.roles.includes('tenant.owner'))
      .map((user) => user.id),
  );
  const ownerName = (id: string | null) => {
    const user = users.find((item) => item.id === id);
    return user ? (user.displayName ?? user.email) : null;
  };
  /** Administrators may not change an owner's personal mailbox. */
  const lockedFor = (mailbox: DirectoryMailbox) =>
    Boolean(
      mailbox.userId &&
        ownerIds.has(mailbox.userId) &&
        !iAmOwner &&
        mailbox.userId !== session?.user.id,
    );

  const selected = mailboxes.find((item) => item.id === selectedId) ?? null;
  const locked = selected ? lockedFor(selected) : false;
  const memberIds = new Set(members.map((member) => member.userId));
  const usersWithMailbox = new Set(
    mailboxes.map((mailbox) => mailbox.userId).filter((id) => id !== null),
  );

  return (
    <>
      <div className="page-header">
        <h1>Mail</h1>
        <p>
          Create user and shared mailboxes, aliases and delegates. Messages are stored in
          ASPECTenant. Configure Cloudflare or SMTP under{' '}
          <Link to="/mail/settings">Mail settings</Link>.
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
          <h2>Provision mailbox</h2>
          <form className="form-grid" onSubmit={onCreate}>
            <div className="field">
              <label htmlFor="mb-kind">Kind</label>
              <select
                id="mb-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as 'shared' | 'user')}
              >
                <option value="shared">Shared</option>
                <option value="user">User</option>
              </select>
            </div>
            {kind === 'user' ? (
              <div className="field">
                <label htmlFor="mb-user">User</label>
                <select
                  id="mb-user"
                  required
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                >
                  <option value="">Select a user</option>
                  {users
                    .filter((user) => !usersWithMailbox.has(user.id))
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.email}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="mb-address">Primary address</label>
              <input
                id="mb-address"
                type="email"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="mb-name">Display name</label>
              <input
                id="mb-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field field-action">
              <button className="btn" type="submit">
                Provision
              </button>
            </div>
          </form>
        </section>
      ) : null}
      <section className="panel">
        <h2>Mailbox directory</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Address</th>
              <th>Name</th>
              <th>Kind</th>
              <th>Aliases</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((mailbox) => (
              <tr key={mailbox.id}>
                <td>{mailbox.primaryAddress}</td>
                <td>{mailbox.displayName ?? ''}</td>
                <td>
                  {mailbox.kind}
                  {mailbox.userId && ownerName(mailbox.userId)
                    ? ` (${ownerName(mailbox.userId)})`
                    : ''}
                </td>
                <td>{mailbox.aliases.join(', ') || 'none'}</td>
                <td className="btn-row">
                  <button className="btn btn-ghost" type="button" onClick={() => select(mailbox)}>
                    {canManage ? 'Manage' : 'View'}
                  </button>
                  {canManage && !lockedFor(mailbox) ? (
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Delete ${mailbox.primaryAddress} and every message in it? This cannot be undone.`,
                          )
                        ) {
                          return;
                        }
                        void act(async () => {
                          await deleteMailbox(mailbox.id);
                          if (selectedId === mailbox.id) setSelectedId(null);
                          await reload();
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
      {selected ? (
        <section className="panel">
          <h2>{selected.primaryAddress}</h2>
          {locked ? (
            <p className="notice">
              This is an owner's mailbox. Only an owner of the organisation can change it.
            </p>
          ) : null}
          {canManage && !locked ? (
            <>
              <h3>Details</h3>
              <form
                className="form-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  const patch: { displayName?: string | null; primaryAddress?: string } = {};
                  if (editName.trim() !== (selected.displayName ?? '')) {
                    patch.displayName = editName.trim() || null;
                  }
                  if (editAddress.trim().toLowerCase() !== selected.primaryAddress) {
                    patch.primaryAddress = editAddress.trim();
                  }
                  void act(
                    async () => {
                      await updateMailbox(selected.id, patch);
                      const next = (await reload()).find((item) => item.id === selected.id);
                      if (next) select(next);
                    },
                    'Could not save the mailbox.',
                    'Mailbox saved.',
                  );
                }}
              >
                <div className="field">
                  <label htmlFor="mb-edit-name">Display name</label>
                  <input
                    id="mb-edit-name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="mb-edit-address">Primary address</label>
                  <input
                    id="mb-edit-address"
                    type="email"
                    required
                    value={editAddress}
                    onChange={(e) => setEditAddress(e.target.value)}
                  />
                </div>
                <div className="field field-action">
                  <button className="btn" type="submit">
                    Save mailbox
                  </button>
                </div>
              </form>
              <p className="muted">
                A replaced primary address is kept as an alias, so mail sent to it still arrives.
              </p>
            </>
          ) : (
            <p>{selected.displayName ?? ''}</p>
          )}
          <h3>Mailbox access</h3>
          <p className="muted">
            {selected.kind === 'user'
              ? 'The linked user always has access. Add delegates who can also read and send.'
              : 'People listed here can read and send from this shared mailbox.'}
          </p>
          {canManage && !locked ? (
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                if (!memberId) return;
                void act(async () => {
                  await addMailboxMember(selected.id, memberId);
                  setMemberId('');
                  setMembers(await listMailboxMembers(selected.id));
                }, 'Could not add access.');
              }}
            >
              <div className="field">
                <label htmlFor="member">Person</label>
                <select id="member" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                  <option value="">Select a user</option>
                  {users
                    .filter((user) => user.id !== selected.userId && !memberIds.has(user.id))
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.email}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field field-action">
                <button className="btn" type="submit" disabled={!memberId}>
                  Grant access
                </button>
              </div>
            </form>
          ) : null}
          <ul>
            {members.map((member) => (
              <li key={member.userId}>
                {member.email ?? member.userId}{' '}
                {canManage && !locked && (iAmOwner || !ownerIds.has(member.userId)) ? (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() =>
                      void act(async () => {
                        await removeMailboxMember(selected.id, member.userId);
                        setMembers(await listMailboxMembers(selected.id));
                      }, 'Remove failed.')
                    }
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <h3>Aliases</h3>
          {canManage && !locked ? (
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await addMailboxAlias(selected.id, alias);
                  setAlias('');
                  await reload();
                }, 'Alias failed.');
              }}
            >
              <div className="field">
                <label htmlFor="alias">Alias</label>
                <input
                  id="alias"
                  type="email"
                  required
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                />
              </div>
              <div className="field field-action">
                <button className="btn" type="submit">
                  Add alias
                </button>
              </div>
            </form>
          ) : null}
          <ul>
            {selected.aliases.map((item) => (
              <li key={item}>
                {item}{' '}
                {canManage && !locked ? (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() =>
                      void act(async () => {
                        await removeMailboxAlias(selected.id, item);
                        await reload();
                      }, 'Remove failed.')
                    }
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
