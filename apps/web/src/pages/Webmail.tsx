import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  deleteMessage,
  emptyFolder,
  getMessage,
  listMessages,
  type MailAddress,
  type MessageDetail,
  type MessageSummary,
  type MyMailbox,
  myMailboxes,
  type SendInput,
  sendMessage,
  updateMessage,
} from '../api.js';

const LABELS: Record<string, string> = { INBOX: 'Inbox' };
const label = (name: string) => LABELS[name] ?? name.split('/').pop() ?? name;
const depth = (name: string) => name.split('/').length - 1;

interface Draft {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  files: File[];
}

const emptyDraft = (from: string): Draft => ({
  from,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  text: '',
  files: [],
});

function who(address: MailAddress | undefined): string {
  if (!address) return '';
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function when(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString();
}

function quote(message: MessageDetail): string {
  const header = `On ${new Date(message.sentAt ?? message.receivedAt).toLocaleString()}, ${who(message.from)} wrote:`;
  return `\n\n${header}\n${message.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`;
}

function htmlDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:"><base target="_blank"><style>body{font-family:system-ui,sans-serif;font-size:14px;margin:0;padding:8px;word-wrap:break-word}</style></head><body>${html}</body></html>`;
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function WebmailPage() {
  const [mailboxes, setMailboxes] = useState<MyMailbox[] | null>(null);
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [folder, setFolder] = useState('INBOX');
  const [search, setSearch] = useState('');
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [open, setOpen] = useState<MessageDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const mailbox = mailboxes?.find((item) => item.id === mailboxId) ?? null;
  const fail = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [],
  );

  const loadMailboxes = useCallback(async () => {
    const items = await myMailboxes();
    setMailboxes(items);
    setMailboxId((current) => current ?? items[0]?.id ?? null);
  }, []);

  const loadMessages = useCallback(async () => {
    if (!mailboxId) return;
    setMessages(await listMessages(mailboxId, folder, search.trim() || undefined));
  }, [mailboxId, folder, search]);

  useEffect(() => {
    void loadMailboxes().catch(fail);
  }, [loadMailboxes, fail]);

  useEffect(() => {
    setOpen(null);
    void loadMessages().catch(fail);
  }, [loadMessages, fail]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadMailboxes().catch(() => undefined);
      void loadMessages().catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadMailboxes, loadMessages]);

  const refresh = async () => {
    await Promise.all([loadMailboxes(), loadMessages()]);
  };

  const openMessage = async (id: string) => {
    setError(null);
    try {
      setOpen(await getMessage(id));
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const reply = (all: boolean) => {
    if (!open || !mailbox) return;
    const target = open.replyTo[0] ?? open.from;
    const own = new Set([mailbox.primaryAddress, ...mailbox.aliases]);
    const cc = all
      ? [...open.to, ...open.cc].map((item) => item.address).filter((item) => !own.has(item))
      : [];
    setDraft({
      ...emptyDraft(mailbox.primaryAddress),
      to: target.address,
      cc: cc.join(', '),
      subject: /^re:/i.test(open.subject) ? open.subject : `Re: ${open.subject}`,
      text: quote(open),
      ...(open.messageId ? { inReplyTo: open.messageId } : {}),
      references: [...open.references, ...(open.messageId ? [open.messageId] : [])],
    });
  };

  const forward = () => {
    if (!open || !mailbox) return;
    setDraft({
      ...emptyDraft(mailbox.primaryAddress),
      subject: /^fwd:/i.test(open.subject) ? open.subject : `Fwd: ${open.subject}`,
      text: `\n\n---------- Forwarded message ----------\nFrom: ${who(open.from)}\nSubject: ${open.subject}\n\n${open.text}`,
    });
  };

  const onSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !mailbox) return;
    setSending(true);
    setError(null);
    try {
      const split = (value: string) =>
        value
          .split(/[,;]/)
          .map((item) => item.trim())
          .filter(Boolean);
      const input: SendInput = {
        mailboxId: mailbox.id,
        from: draft.from,
        to: split(draft.to),
        cc: split(draft.cc),
        bcc: split(draft.bcc),
        subject: draft.subject,
        text: draft.text,
        ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
        ...(draft.references?.length ? { references: draft.references } : {}),
        attachments: await Promise.all(
          draft.files.map(async (file) => ({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            contentBase64: await toBase64(file),
          })),
        ),
      };
      await sendMessage(input);
      setDraft(null);
      setNotice('Message sent.');
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  };

  const move = async (target: string) => {
    if (!open) return;
    try {
      await updateMessage(open.id, { folder: target });
      setOpen(null);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async () => {
    if (!open) return;
    try {
      await deleteMessage(open.id);
      setOpen(null);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  if (mailboxes && mailboxes.length === 0) {
    return (
      <>
        <div className="page-header">
          <h1>Mailbox</h1>
        </div>
        <p className="notice">
          You do not have a mailbox yet. An administrator can create one under Mail.
        </p>
      </>
    );
  }

  return (
    <div className="webmail">
      <aside className="wm-folders">
        {mailboxes && mailboxes.length > 1 ? (
          <select
            aria-label="Mailbox"
            value={mailboxId ?? ''}
            onChange={(event) => setMailboxId(event.target.value)}
          >
            {mailboxes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.primaryAddress}
              </option>
            ))}
          </select>
        ) : (
          <strong className="wm-address">{mailbox?.primaryAddress}</strong>
        )}
        <button
          className="btn"
          type="button"
          disabled={!mailbox}
          onClick={() => mailbox && setDraft(emptyDraft(mailbox.primaryAddress))}
        >
          New message
        </button>
        <nav>
          {(mailbox?.folders ?? []).map((item) => {
            const unread = item.unread;
            return (
              <button
                key={item.name}
                type="button"
                className={folder === item.name ? 'active' : ''}
                style={{ paddingLeft: 8 + depth(item.name) * 12 }}
                onClick={() => setFolder(item.name)}
              >
                <span>{label(item.name)}</span>
                {unread > 0 ? <span className="badge badge-ok">{unread}</span> : null}
              </button>
            );
          })}
        </nav>
        {mailbox && (folder === 'Trash' || folder === 'Junk') && messages.length > 0 ? (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              if (!window.confirm('Permanently delete every message in this folder?')) return;
              void emptyFolder(mailbox.id, folder).then(refresh).catch(fail);
            }}
          >
            Empty {folder}
          </button>
        ) : null}
      </aside>

      <section className="wm-list">
        <input
          type="search"
          placeholder="Search subject, sender or text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {messages.length === 0 ? <p className="muted">No messages.</p> : null}
        <ul>
          {messages.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                className={[
                  open?.id === message.id ? 'active' : '',
                  message.seen ? '' : 'unread',
                ].join(' ')}
                onClick={() => void openMessage(message.id)}
              >
                <span className="wm-row">
                  <span className="wm-from">
                    {folder === 'Sent'
                      ? `To: ${message.to.map((item) => item.address).join(', ')}`
                      : message.from.name || message.from.address}
                  </span>
                  <span className="muted">{when(message.receivedAt)}</span>
                </span>
                <span className="wm-subject">
                  {message.hasAttachments ? '📎 ' : ''}
                  {message.subject}
                </span>
                <span className="wm-snippet muted">{message.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="wm-read">
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice && !error ? <p className="notice">{notice}</p> : null}
        {draft && mailbox ? (
          <form className="wm-compose" onSubmit={(event) => void onSend(event)}>
            <h2>{draft.inReplyTo ? 'Reply' : 'New message'}</h2>
            <label>
              From
              <select
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              >
                {[mailbox.primaryAddress, ...mailbox.aliases].map((address) => (
                  <option key={address} value={address}>
                    {address}
                  </option>
                ))}
              </select>
            </label>
            <label>
              To
              <input
                required
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </label>
            <label>
              Cc
              <input
                value={draft.cc}
                onChange={(event) => setDraft({ ...draft, cc: event.target.value })}
              />
            </label>
            <label>
              Bcc
              <input
                value={draft.bcc}
                onChange={(event) => setDraft({ ...draft, bcc: event.target.value })}
              />
            </label>
            <label>
              Subject
              <input
                value={draft.subject}
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              />
            </label>
            <textarea
              rows={16}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            <label>
              Attachments
              <input
                type="file"
                multiple
                onChange={(event) =>
                  setDraft({ ...draft, files: Array.from(event.target.files ?? []) })
                }
              />
            </label>
            <div className="btn-row">
              <button className="btn" type="submit" disabled={sending}>
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setDraft(null)}>
                Discard
              </button>
            </div>
          </form>
        ) : open ? (
          <article>
            <div className="btn-row wm-actions">
              <button className="btn" type="button" onClick={() => reply(false)}>
                Reply
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => reply(true)}>
                Reply all
              </button>
              <button className="btn btn-ghost" type="button" onClick={forward}>
                Forward
              </button>
              {open.folder !== 'Archive' ? (
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => void move('Archive')}
                >
                  Archive
                </button>
              ) : null}
              {open.folder === 'Junk' ? (
                <button className="btn btn-ghost" type="button" onClick={() => void move('INBOX')}>
                  Not junk
                </button>
              ) : (
                <button className="btn btn-ghost" type="button" onClick={() => void move('Junk')}>
                  Junk
                </button>
              )}
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => void updateMessage(open.id, { seen: false }).then(refresh)}
              >
                Mark unread
              </button>
              <button className="btn btn-danger" type="button" onClick={() => void remove()}>
                {open.folder === 'Trash' ? 'Delete forever' : 'Delete'}
              </button>
            </div>
            <h2>{open.subject}</h2>
            <dl className="wm-headers">
              <dt>From</dt>
              <dd>{who(open.from)}</dd>
              <dt>To</dt>
              <dd>{open.to.map(who).join(', ')}</dd>
              {open.cc.length > 0 ? (
                <>
                  <dt>Cc</dt>
                  <dd>{open.cc.map(who).join(', ')}</dd>
                </>
              ) : null}
              <dt>Date</dt>
              <dd>{new Date(open.sentAt ?? open.receivedAt).toLocaleString()}</dd>
            </dl>
            {open.attachments.length > 0 ? (
              <ul className="wm-attachments">
                {open.attachments.map((item) => (
                  <li key={item.index}>
                    <a href={`/api/v1/mail/messages/${open.id}/attachments/${item.index}`}>
                      {item.filename}
                    </a>{' '}
                    <span className="muted">({Math.ceil(item.size / 1024)} KB)</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {open.html ? (
              <iframe
                className="wm-body"
                title="Message body"
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                srcDoc={htmlDocument(open.html)}
              />
            ) : (
              <pre className="wm-text">{open.text}</pre>
            )}
            <p>
              <a href={`/api/v1/mail/messages/${open.id}/raw`}>Download original (.eml)</a>
            </p>
          </article>
        ) : (
          <p className="muted">Select a message to read it.</p>
        )}
      </section>
    </div>
  );
}
