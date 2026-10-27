import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type BatchAction,
  batchMessages,
  createFolder,
  deleteFolder,
  emptyFolder,
  getMailPreferences,
  getMessage,
  getSetupState,
  listMessages,
  logout,
  type MailPreferences,
  type MessageDetail,
  type MessageSummary,
  type MyMailbox,
  myMailboxes,
  renameFolder,
  tenantLink,
} from '../api.js';
import { useAuth } from '../auth.js';
import { SignInForm } from '../layout/SignInForm.js';
import { Compose, type ComposeAttachment, type ComposeState } from './Compose.js';
import {
  avatarHue,
  dateGroup,
  escapeHtml,
  fileSize,
  folderDepth,
  folderLabel,
  initials,
  isSystemFolder,
  listTime,
  MAIL_APP_NAME,
  quotedHtml,
  readingDocument,
  SYSTEM_ORDER,
  shortName,
  textToHtml,
  toBase64,
  who,
} from './format.js';
import { MailOptions } from './MailOptions.js';
import { registerMailApp, useInstallPrompt } from './pwa.js';
import './mail.css';

const PAGE = 50;
const POLL_MS = 30_000;
const NOTIFY_KEY = 'aspectenant-mail-notify';

type Filter = 'all' | 'unread' | 'flagged';
type MobileView = 'folders' | 'list' | 'read';

function readNotify(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'on';
  } catch {
    return false;
  }
}

function sortFolders(mailbox: MyMailbox) {
  return [...mailbox.folders].sort((a, b) => {
    const rootA = a.name.split('/')[0] ?? a.name;
    const rootB = b.name.split('/')[0] ?? b.name;
    const ia = SYSTEM_ORDER.indexOf(rootA);
    const ib = SYSTEM_ORDER.indexOf(rootB);
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.name.localeCompare(b.name);
  });
}

function ThemeButton() {
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  return (
    <button
      className="mx-icon"
      type="button"
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('aspectenant-theme', next);
        } catch {
          // Storage can be unavailable (private mode); the toggle still works for this page.
        }
        setTheme(next);
      }}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

function Avatar({ address }: { address: MessageSummary['from'] }) {
  return (
    <span className="mx-avatar" style={{ background: `hsl(${avatarHue(address)} 45% 42%)` }}>
      {initials(address)}
    </span>
  );
}

/** Sign-in page of the mail app, at /mail/ for anyone without a session. */
function MailSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [setupRequired, setSetupRequired] = useState(false);
  useEffect(() => {
    void getSetupState()
      .then((state) => setSetupRequired(state.required))
      .catch(() => setSetupRequired(false));
  }, []);
  return (
    <div className="auth-page mx-auth">
      <div className="auth-brand">
        <img src="/logo.png" alt="" />
        <strong>{MAIL_APP_NAME}</strong>
      </div>
      <div className="auth-card">
        <h1>Sign in to {MAIL_APP_NAME}</h1>
        <p>Use your organisation email address and password.</p>
        {setupRequired ? (
          <p className="notice">
            This installation has not been set up yet. <a href="/setup">Set it up</a> first.
          </p>
        ) : (
          <SignInForm onSignedIn={onSignedIn} />
        )}
      </div>
    </div>
  );
}

export function MailApp() {
  const { loading, session, refresh } = useAuth();
  useEffect(registerMailApp, []);

  if (loading) {
    return (
      <div className="mx-splash">
        <img src="/logo.png" alt="" />
        <span>{MAIL_APP_NAME}</span>
      </div>
    );
  }
  if (!session) return <MailSignIn onSignedIn={refresh} />;
  if (!session.organisation) {
    return (
      <div className="auth-page mx-auth">
        <div className="auth-card">
          <h1>No organisation</h1>
          <p>
            {session.user.email} is not an active member of an organisation, so there is no mailbox
            to open. Ask an administrator of your organisation to add you.
          </p>
          <button className="btn" type="button" onClick={() => void logout().then(() => refresh())}>
            Sign out
          </button>
        </div>
      </div>
    );
  }
  return <Workspace key={session.organisation.id} />;
}

function Workspace() {
  const { session, refresh: refreshSession, selectTenant } = useAuth();
  const [mailboxes, setMailboxes] = useState<MyMailbox[] | null>(null);
  const [preferences, setPreferences] = useState<MailPreferences | null>(null);
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [folder, setFolder] = useState('INBOX');
  const [filter, setFilter] = useState<Filter>('all');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<MessageDetail | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [options, setOptions] = useState(false);
  const [notify, setNotify] = useState(readNotify);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [mobile, setMobile] = useState<MobileView>('list');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const install = useInstallPrompt();
  const lastUnread = useRef<number | null>(null);
  const listRequest = useRef(0);

  const mailbox = mailboxes?.find((item) => item.id === mailboxId) ?? null;
  const canAdmin = (session?.permissions ?? []).some((item) =>
    ['system:read', 'users:read', 'mail:read', 'platform:admin'].includes(item),
  );
  const pane = preferences?.readingPane ?? 'right';

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  const loadMailboxes = useCallback(async () => {
    const items = await myMailboxes();
    setMailboxes(items);
    setMailboxId((current) =>
      current && items.some((item) => item.id === current) ? current : (items[0]?.id ?? null),
    );
    return items;
  }, []);

  /** Loads the first page, or the page after `before` (the oldest time shown) for Load more. */
  const loadMessages = useCallback(
    async (before?: number) => {
      if (!mailboxId) return;
      const request = ++listRequest.current;
      setListLoading(true);
      try {
        const items = await listMessages(mailboxId, folder, search || undefined, {
          ...(filter !== 'all' ? { filter } : {}),
          ...(before !== undefined ? { before } : {}),
          limit: PAGE,
        });
        if (request !== listRequest.current) return;
        setMessages((current) => (before !== undefined ? [...current, ...items] : items));
        setHasMore(items.length === PAGE);
      } finally {
        if (request === listRequest.current) setListLoading(false);
      }
    },
    [mailboxId, folder, search, filter],
  );

  // Reload the first page; the list keeps what is open and selected where it still exists.
  const reloadList = useCallback(async () => {
    if (!mailboxId) return;
    const request = ++listRequest.current;
    const items = await listMessages(mailboxId, folder, search || undefined, {
      ...(filter !== 'all' ? { filter } : {}),
      limit: Math.max(PAGE, messages.length),
    });
    if (request !== listRequest.current) return;
    setMessages(items);
    setHasMore(items.length >= PAGE && items.length % PAGE === 0);
  }, [mailboxId, folder, search, filter, messages.length]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadMailboxes(), reloadList()]);
  }, [loadMailboxes, reloadList]);

  useEffect(() => {
    void Promise.all([loadMailboxes(), getMailPreferences().then(setPreferences)]).catch(fail);
  }, [loadMailboxes, fail]);

  // Debounced search, like Outlook's search box.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  // A new folder, filter or search starts a fresh list.
  useEffect(() => {
    setSelected(new Set());
    setMessages([]);
    void loadMessages().catch(fail);
  }, [loadMessages, fail]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshAll().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  // Unread count in the tab title and a desktop notification for new inbox mail.
  useEffect(() => {
    const unread = (mailboxes ?? [])
      .filter((item) => !item.operator)
      .reduce((sum, item) => sum + (item.folders.find((f) => f.name === 'INBOX')?.unread ?? 0), 0);
    const title = mailbox ? `${folderLabel(folder)} - ${mailbox.primaryAddress}` : MAIL_APP_NAME;
    document.title = unread > 0 ? `(${unread}) ${title}` : title;
    if (
      notify &&
      lastUnread.current !== null &&
      unread > lastUnread.current &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      document.visibilityState !== 'visible'
    ) {
      const count = unread - lastUnread.current;
      new Notification(MAIL_APP_NAME, {
        body: count === 1 ? 'You have a new message.' : `You have ${count} new messages.`,
        icon: '/logo.png',
        tag: 'aspectenant-mail',
      });
    }
    if (mailboxes) lastUnread.current = unread;
  }, [mailboxes, mailbox, folder, notify]);

  // Leaving for the admin pages puts their title back.
  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);

  // The installed app's "New mail" shortcut opens /mail/?compose=new.
  const composeOnStart = useRef(new URLSearchParams(window.location.search).get('compose'));
  useEffect(() => {
    if (composeOnStart.current !== 'new' || !mailbox || !preferences) return;
    composeOnStart.current = null;
    window.history.replaceState(null, '', '/mail/');
    setCompose({
      key: 'shortcut',
      title: 'New message',
      mailboxId: mailbox.id,
      from: mailbox.primaryAddress,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      html: preferences.signature.trim()
        ? `<br><br><div class="signature">${textToHtml(preferences.signature)}</div>`
        : '',
      attachments: [],
    });
    setMobile('read');
  }, [mailbox, preferences]);

  const setNotifications = (on: boolean) => {
    const save = (value: boolean) => {
      setNotify(value);
      try {
        localStorage.setItem(NOTIFY_KEY, value ? 'on' : 'off');
      } catch {
        // Storage unavailable: the choice lasts for this page.
      }
    };
    if (!on) return save(false);
    if (typeof Notification === 'undefined') {
      fail(new Error('This browser does not support notifications.'));
      return;
    }
    void Notification.requestPermission().then((permission) => save(permission === 'granted'));
  };

  const chooseFolder = (id: string, name: string) => {
    setMailboxId(id);
    setFolder(name);
    setOpen(null);
    setCompose(null);
    setFolderMenu(null);
    setMobile('list');
  };

  const signature = (reply: boolean) => {
    if (!preferences?.signature.trim()) return '';
    if (reply && !preferences.signatureOnReplies) return '';
    return `<br><br><div class="signature">${textToHtml(preferences.signature)}</div>`;
  };

  const startCompose = (patch: Partial<ComposeState> & { title: string }) => {
    if (!mailbox) return;
    setCompose({
      key: `${Date.now()}`,
      mailboxId: mailbox.id,
      from: mailbox.primaryAddress,
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      html: '',
      attachments: [],
      ...patch,
    });
    setMobile('read');
  };

  const newMessage = () => startCompose({ title: 'New message', html: signature(false) });

  const reply = (all: boolean) => {
    if (!open || !mailbox) return;
    const own = new Set([mailbox.primaryAddress, ...mailbox.aliases]);
    const target = (open.replyTo[0] ?? open.from).address;
    const cc = all
      ? [...open.to, ...open.cc]
          .map((item) => item.address)
          .filter((item) => !own.has(item) && item !== target)
      : [];
    const from = [...open.to, ...open.cc].find((item) => own.has(item.address))?.address;
    startCompose({
      title: all ? 'Reply all' : 'Reply',
      from: from ?? mailbox.primaryAddress,
      to: own.has(target) ? open.to.map((item) => item.address) : [target],
      cc: [...new Set(cc)],
      subject: /^re:/i.test(open.subject) ? open.subject : `RE: ${open.subject}`,
      html: `${signature(true)}${quotedHtml(open, false)}`,
      ...(open.messageId ? { inReplyTo: open.messageId } : {}),
      references: [...open.references, ...(open.messageId ? [open.messageId] : [])],
    });
  };

  const forward = async () => {
    if (!open || !mailbox) return;
    try {
      // Forwarding keeps the attachments, like Outlook.
      const attachments: ComposeAttachment[] = await Promise.all(
        open.attachments.map(async (item) => {
          const response = await fetch(
            tenantLink(`/api/v1/mail/messages/${open.id}/attachments/${item.index}`),
            { credentials: 'include' },
          );
          if (!response.ok) throw new Error(`Could not load ${item.filename}.`);
          const blob = await response.blob();
          return {
            filename: item.filename,
            contentType: item.contentType,
            size: blob.size,
            contentBase64: await toBase64(blob),
          };
        }),
      );
      startCompose({
        title: 'Forward',
        subject: /^fw(d)?:/i.test(open.subject) ? open.subject : `FW: ${open.subject}`,
        html: `${signature(true)}${quotedHtml(open, true)}`,
        attachments,
      });
    } catch (err) {
      fail(err);
    }
  };

  /** Opens a saved draft in the composer, attachments included. */
  const editDraft = async (id: string) => {
    if (!mailbox) return;
    try {
      const draft = await getMessage(id, false);
      const attachments = await Promise.all(
        draft.attachments.map(async (item) => {
          const response = await fetch(
            tenantLink(`/api/v1/mail/messages/${draft.id}/attachments/${item.index}`),
            { credentials: 'include' },
          );
          const blob = await response.blob();
          return {
            filename: item.filename,
            contentType: item.contentType,
            size: blob.size,
            contentBase64: await toBase64(blob),
          };
        }),
      );
      setOpen(null);
      startCompose({
        title: 'Draft',
        mailboxId: draft.mailboxId,
        from: draft.from.address,
        to: draft.to.map((item) => item.address),
        cc: draft.cc.map((item) => item.address),
        bcc: draft.bcc.map((item) => item.address),
        subject: draft.subject === '(no subject)' ? '' : draft.subject,
        html: draft.html ?? textToHtml(draft.text),
        attachments,
        draftId: draft.id,
        references: draft.references,
      });
    } catch (err) {
      fail(err);
    }
  };

  const openMessage = async (message: MessageSummary) => {
    setError(null);
    if (folder === 'Drafts' || message.draft) {
      await editDraft(message.id);
      return;
    }
    setCompose(null);
    try {
      const markRead = preferences?.markReadOnOpen ?? true;
      const detail = await getMessage(message.id, markRead);
      setOpen(detail);
      setMobile('read');
      if (markRead && !message.seen) {
        setMessages((items) =>
          items.map((item) => (item.id === message.id ? { ...item, seen: true } : item)),
        );
        void loadMailboxes().catch(() => undefined);
      }
    } catch (err) {
      fail(err);
    }
  };

  /** Runs an action on the selection, or on the open message when nothing is selected. */
  const act = async (action: BatchAction, target?: string, ids?: string[]) => {
    const chosen = ids ?? (selected.size > 0 ? [...selected] : open ? [open.id] : []);
    if (chosen.length === 0) return;
    setError(null);
    try {
      await batchMessages(chosen, action, target);
      if (action === 'move' || action === 'delete') {
        if (open && chosen.includes(open.id)) {
          // Move on to the next message, as Outlook does.
          const index = messages.findIndex((item) => item.id === open.id);
          const next = messages.slice(index + 1).find((item) => !chosen.includes(item.id));
          setOpen(null);
          if (next && pane !== 'off') void openMessage(next);
        }
        setMessages((items) => items.filter((item) => !chosen.includes(item.id)));
        setSelected(new Set());
        flash(
          action === 'delete'
            ? folder === 'Trash'
              ? `${chosen.length} deleted permanently.`
              : `${chosen.length} moved to Deleted Items.`
            : `${chosen.length} moved to ${folderLabel(target ?? '')}.`,
        );
      } else {
        const patch: Partial<MessageSummary> =
          action === 'read' || action === 'unread'
            ? { seen: action === 'read' }
            : { flagged: action === 'flag' };
        setMessages((items) =>
          items.map((item) => (chosen.includes(item.id) ? { ...item, ...patch } : item)),
        );
        if (open && chosen.includes(open.id)) setOpen({ ...open, ...patch });
      }
      await loadMailboxes();
    } catch (err) {
      fail(err);
    }
  };

  const markAllRead = async (target: MyMailbox, name: string) => {
    setFolderMenu(null);
    try {
      for (;;) {
        const unread = await listMessages(target.id, name, undefined, {
          filter: 'unread',
          limit: 200,
        });
        if (unread.length === 0) break;
        await batchMessages(
          unread.map((item) => item.id),
          'read',
        );
      }
      await refreshAll();
    } catch (err) {
      fail(err);
    }
  };

  const folderAction = async (
    target: MyMailbox,
    name: string,
    kind: 'new' | 'rename' | 'delete' | 'empty',
  ) => {
    setFolderMenu(null);
    try {
      if (kind === 'new') {
        const child = window.prompt(
          name ? `New folder inside ${folderLabel(name)}` : 'New folder name',
        );
        if (!child?.trim()) return;
        const full = name && name !== 'INBOX' ? `${name}/${child.trim()}` : child.trim();
        await createFolder(target.id, name === 'INBOX' ? `INBOX/${child.trim()}` : full);
      } else if (kind === 'rename') {
        const leaf = window.prompt('Rename folder', folderLabel(name));
        if (!leaf?.trim() || leaf.trim() === folderLabel(name)) return;
        const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
        await renameFolder(target.id, name, `${parent}${leaf.trim()}`);
        if (folder === name) setFolder(`${parent}${leaf.trim()}`);
      } else if (kind === 'delete') {
        if (
          !window.confirm(
            `Delete the folder ${folderLabel(name)}? Its messages and subfolders move to Deleted Items.`,
          )
        ) {
          return;
        }
        await deleteFolder(target.id, name);
        if (folder === name || folder.startsWith(`${name}/`)) setFolder('INBOX');
      } else if (kind === 'empty') {
        if (!window.confirm(`Permanently delete everything in ${folderLabel(name)}?`)) return;
        await emptyFolder(target.id, name);
        if (folder === name) setMessages([]);
      }
      await refreshAll();
    } catch (err) {
      fail(err);
    }
  };

  // Drag messages onto a folder to move them.
  const onDragStart = (event: DragEvent, message: MessageSummary) => {
    const ids = selected.has(message.id) ? [...selected] : [message.id];
    event.dataTransfer.setData('application/x-aspectenant-mail', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (event: DragEvent, targetMailbox: string, name: string) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData('application/x-aspectenant-mail');
    if (!raw || targetMailbox !== mailboxId || name === folder) return;
    void act('move', name, JSON.parse(raw) as string[]);
  };

  // Keyboard shortcuts (Outlook on the web style), ignored while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (compose || options) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if ((ctrl && key === 'n') || (!ctrl && key === 'n')) {
        event.preventDefault();
        newMessage();
      } else if (event.key === 'Delete') {
        event.preventDefault();
        void act('delete');
      } else if (ctrl && event.shiftKey && key === 'r') {
        event.preventDefault();
        reply(true);
      } else if (ctrl && event.shiftKey && key === 'f') {
        event.preventDefault();
        void forward();
      } else if (ctrl && key === 'r') {
        event.preventDefault();
        reply(false);
      } else if (ctrl && key === 'q') {
        event.preventDefault();
        void act('read');
      } else if (ctrl && key === 'u') {
        event.preventDefault();
        void act('unread');
      } else if (key === 'e' && !ctrl) {
        void act('move', 'Archive');
      } else if (key === 'escape') {
        setOpen(null);
        setSelected(new Set());
      } else if ((key === 'arrowdown' || key === 'arrowup' || key === 'j' || key === 'k') && open) {
        const index = messages.findIndex((item) => item.id === open.id);
        const next = messages[index + (key === 'arrowdown' || key === 'j' ? 1 : -1)];
        if (next) {
          event.preventDefault();
          void openMessage(next);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: MessageSummary[] }> = [];
    for (const message of messages) {
      const label = preferences?.groupByDate === false ? '' : dateGroup(message.receivedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(message);
      else out.push({ label, items: [message] });
    }
    return out;
  }, [messages, preferences?.groupByDate]);

  const otherFolders = (mailbox ? sortFolders(mailbox) : []).filter((item) => item.name !== folder);
  const allSelected = messages.length > 0 && messages.every((item) => selected.has(item.id));
  const showSent = folder === 'Sent' || folder === 'Drafts';
  const readingVisible = pane !== 'off' || open !== null || compose !== null;

  if (mailboxes && mailboxes.length === 0) {
    return (
      <div className="mx-app">
        <TopBar
          canAdmin={canAdmin}
          install={install}
          onOptions={() => undefined}
          onSignOut={() => void logout().then(() => refreshSession())}
          onSelectTenant={(id) => void selectTenant(id)}
        />
        <div className="mx-empty-state">
          <h2>No mailbox yet</h2>
          <p>
            {session?.user.email} does not have a mailbox in {session?.organisation?.name}. An
            administrator can create one on the Mailboxes page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`mx-app mx-pane-${pane} mx-mobile-${mobile}`}>
      <TopBar
        canAdmin={canAdmin}
        install={install}
        search={searchText}
        onSearch={setSearchText}
        onOptions={() => setOptions(true)}
        onSignOut={() => void logout().then(() => refreshSession())}
        onSelectTenant={(id) => void selectTenant(id)}
      />
      {preferences?.autoReply.enabled ? (
        <div className="mx-banner">
          Automatic replies are on.{' '}
          <button className="mx-link" type="button" onClick={() => setOptions(true)}>
            Change
          </button>
        </div>
      ) : null}
      <div className="mx-body">
        <nav className="mx-folders" aria-label="Folders">
          <button className="btn mx-new" type="button" disabled={!mailbox} onClick={newMessage}>
            New mail
          </button>
          {(mailboxes ?? []).map((item) => {
            const isCollapsed = collapsed.has(item.id);
            return (
              <section key={item.id} className="mx-mailbox">
                <header>
                  <button
                    type="button"
                    className="mx-mailbox-name"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  >
                    <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                    <span title={item.primaryAddress}>
                      {item.displayName || item.primaryAddress}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mx-icon"
                    title="New folder"
                    aria-label={`New folder in ${item.primaryAddress}`}
                    onClick={() => void folderAction(item, '', 'new')}
                  >
                    +
                  </button>
                </header>
                {item.operator ? <p className="mx-operator">Operator access, audited</p> : null}
                {isCollapsed ? null : (
                  <ul>
                    {sortFolders(item).map((entry) => {
                      const active = item.id === mailboxId && entry.name === folder;
                      const menuKey = `${item.id}:${entry.name}`;
                      const count = entry.name === 'Drafts' ? entry.total : entry.unread;
                      return (
                        <li
                          key={entry.name}
                          onDragOver={(event) => {
                            if (item.id === mailboxId) event.preventDefault();
                          }}
                          onDrop={(event) => onDrop(event, item.id, entry.name)}
                        >
                          <button
                            type="button"
                            className={active ? 'active' : ''}
                            style={{ paddingLeft: 12 + folderDepth(entry.name) * 14 }}
                            onClick={() => chooseFolder(item.id, entry.name)}
                          >
                            <span>{folderLabel(entry.name)}</span>
                            {count > 0 ? (
                              <span className={entry.name === 'Drafts' ? 'mx-count' : 'mx-unread'}>
                                {count}
                              </span>
                            ) : null}
                          </button>
                          <button
                            type="button"
                            className="mx-icon mx-folder-more"
                            aria-label={`More actions for ${folderLabel(entry.name)}`}
                            aria-expanded={folderMenu === menuKey}
                            onClick={() =>
                              setFolderMenu((current) => (current === menuKey ? null : menuKey))
                            }
                          >
                            ⋯
                          </button>
                          {folderMenu === menuKey ? (
                            <div className="mx-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void folderAction(item, entry.name, 'new')}
                              >
                                New subfolder
                              </button>
                              {entry.unread > 0 ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => void markAllRead(item, entry.name)}
                                >
                                  Mark all as read
                                </button>
                              ) : null}
                              {entry.name === 'Trash' || entry.name === 'Junk' ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => void folderAction(item, entry.name, 'empty')}
                                >
                                  Empty folder
                                </button>
                              ) : null}
                              {isSystemFolder(entry.name) ? null : (
                                <>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => void folderAction(item, entry.name, 'rename')}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="danger"
                                    onClick={() => void folderAction(item, entry.name, 'delete')}
                                  >
                                    Delete folder
                                  </button>
                                </>
                              )}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </nav>

        <section className="mx-list" aria-label="Messages">
          <div className="mx-list-head">
            <button
              type="button"
              className="mx-icon mx-back"
              aria-label="Folders"
              onClick={() => setMobile('folders')}
            >
              ☰
            </button>
            <h1>{search ? `Results in ${folderLabel(folder)}` : folderLabel(folder)}</h1>
            <div className="mx-filters">
              {(['all', 'unread', 'flagged'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? 'active' : ''}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? 'All' : value === 'unread' ? 'Unread' : 'Flagged'}
                </button>
              ))}
            </div>
          </div>
          {selected.size > 0 ? (
            <div className="mx-bulk">
              <label className="mx-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(messages.map((item) => item.id)))
                  }
                />
                {selected.size} selected
              </label>
              <button type="button" onClick={() => void act('delete')}>
                Delete
              </button>
              {folder !== 'Archive' ? (
                <button type="button" onClick={() => void act('move', 'Archive')}>
                  Archive
                </button>
              ) : null}
              <button type="button" onClick={() => void act('read')}>
                Read
              </button>
              <button type="button" onClick={() => void act('unread')}>
                Unread
              </button>
              <button type="button" onClick={() => void act('flag')}>
                Flag
              </button>
              <MoveSelect folders={otherFolders} onMove={(name) => void act('move', name)} />
            </div>
          ) : null}
          <div className="mx-rows">
            {messages.length === 0 && !listLoading ? (
              <p className="mx-empty">
                {search
                  ? 'No results.'
                  : filter === 'unread'
                    ? 'Nothing unread.'
                    : filter === 'flagged'
                      ? 'Nothing flagged.'
                      : 'This folder is empty.'}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={`${group.label}-${group.items[0]?.id}`}>
                {group.label ? <h2 className="mx-group">{group.label}</h2> : null}
                <ul>
                  {group.items.map((message) => {
                    const person = showSent ? message.to[0] : message.from;
                    const isSelected = selected.has(message.id);
                    return (
                      <li
                        key={message.id}
                        draggable
                        onDragStart={(event) => onDragStart(event, message)}
                        className={[
                          'mx-row',
                          message.seen ? '' : 'unread',
                          open?.id === message.id ? 'active' : '',
                          isSelected ? 'selected' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <label className="mx-select">
                          <input
                            type="checkbox"
                            aria-label={`Select ${message.subject}`}
                            checked={isSelected}
                            onChange={() =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (next.has(message.id)) next.delete(message.id);
                                else next.add(message.id);
                                return next;
                              })
                            }
                          />
                          <Avatar address={person ?? message.from} />
                        </label>
                        <button
                          type="button"
                          className="mx-row-main"
                          onClick={(event) => {
                            if (event.ctrlKey || event.metaKey) {
                              setSelected((current) => new Set(current).add(message.id));
                              return;
                            }
                            void openMessage(message);
                          }}
                        >
                          <span className="mx-row-top">
                            <span className="mx-from">
                              {folder === 'Drafts' ? <em className="mx-draft">[Draft] </em> : null}
                              {showSent
                                ? message.to.map((item) => shortName(item)).join('; ') ||
                                  '(no recipients)'
                                : shortName(message.from)}
                            </span>
                            <span className="mx-time">{listTime(message.receivedAt)}</span>
                          </span>
                          <span className="mx-subject">
                            {message.hasAttachments ? (
                              <span title="Has attachments">📎 </span>
                            ) : null}
                            {message.answered ? <span title="Replied">↩ </span> : null}
                            {message.subject}
                          </span>
                          <span className="mx-snippet">{message.snippet}</span>
                        </button>
                        <span className="mx-row-actions">
                          <button
                            type="button"
                            className={`mx-icon${message.flagged ? ' flagged' : ''}`}
                            aria-label={message.flagged ? 'Clear flag' : 'Flag'}
                            title={message.flagged ? 'Clear flag' : 'Flag'}
                            onClick={() =>
                              void act(message.flagged ? 'unflag' : 'flag', undefined, [message.id])
                            }
                          >
                            ⚑
                          </button>
                          <button
                            type="button"
                            className="mx-icon"
                            aria-label={message.seen ? 'Mark as unread' : 'Mark as read'}
                            title={message.seen ? 'Mark as unread' : 'Mark as read'}
                            onClick={() =>
                              void act(message.seen ? 'unread' : 'read', undefined, [message.id])
                            }
                          >
                            {message.seen ? '○' : '●'}
                          </button>
                          <button
                            type="button"
                            className="mx-icon"
                            aria-label="Delete"
                            title="Delete"
                            onClick={() => void act('delete', undefined, [message.id])}
                          >
                            🗑
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {hasMore ? (
              <button
                type="button"
                className="btn btn-ghost mx-more"
                disabled={listLoading}
                onClick={() =>
                  void loadMessages(messages[messages.length - 1]?.receivedAt).catch(fail)
                }
              >
                {listLoading ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
            {listLoading && messages.length === 0 ? <p className="mx-empty">Loading…</p> : null}
          </div>
        </section>

        {readingVisible ? (
          <section className="mx-read" aria-label="Reading pane">
            {error ? (
              <p className="notice notice-error" role="alert">
                {error}{' '}
                <button className="mx-link" type="button" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </p>
            ) : null}
            {compose && mailboxes ? (
              <>
                <div className="mx-read-head">
                  <button
                    type="button"
                    className="mx-icon mx-back"
                    aria-label="Back"
                    onClick={() => setMobile('list')}
                  >
                    ←
                  </button>
                  <h2>{compose.title}</h2>
                </div>
                <Compose
                  key={compose.key}
                  initial={compose}
                  mailboxes={mailboxes}
                  onChanged={() => {
                    if (folder === 'Drafts') void reloadList().catch(() => undefined);
                    void loadMailboxes().catch(() => undefined);
                  }}
                  onClose={(result) => {
                    setCompose(null);
                    setMobile('list');
                    if (result === 'sent') flash('Message sent.');
                    if (result === 'discarded') flash('Draft discarded.');
                    void refreshAll().catch(() => undefined);
                  }}
                />
              </>
            ) : open ? (
              <Reader
                message={open}
                folders={(mailbox ? sortFolders(mailbox) : []).filter(
                  (item) => item.name !== open.folder,
                )}
                onBack={() => {
                  setOpen(null);
                  setMobile('list');
                }}
                onReply={() => reply(false)}
                onReplyAll={() => reply(true)}
                onForward={() => void forward()}
                onAction={(action, target) => void act(action, target, [open.id])}
              />
            ) : (
              <div className="mx-empty-state">
                <img src="/logo.png" alt="" />
                <p>Select an item to read</p>
                <p className="muted">
                  {mailbox ? `${folderLabel(folder)} in ${mailbox.primaryAddress}` : ''}
                </p>
              </div>
            )}
          </section>
        ) : null}
      </div>
      {toast ? (
        <output className="mx-toast" aria-live="polite">
          {toast}
        </output>
      ) : null}
      {options && preferences ? (
        <MailOptions
          preferences={preferences}
          notifications={notify}
          onNotifications={setNotifications}
          onSaved={(saved) => {
            setPreferences(saved);
            flash('Settings saved.');
          }}
          onClose={() => setOptions(false)}
        />
      ) : null}
    </div>
  );
}

function MoveSelect({
  folders,
  onMove,
}: {
  folders: Array<{ name: string }>;
  onMove: (name: string) => void;
}) {
  return (
    <select
      aria-label="Move to"
      value=""
      onChange={(event) => {
        if (event.target.value) onMove(event.target.value);
      }}
    >
      <option value="">Move to…</option>
      {folders.map((item) => (
        <option key={item.name} value={item.name}>
          {'  '.repeat(folderDepth(item.name))}
          {folderLabel(item.name)}
        </option>
      ))}
    </select>
  );
}

function TopBar({
  canAdmin,
  install,
  search,
  onSearch,
  onOptions,
  onSignOut,
  onSelectTenant,
}: {
  canAdmin: boolean;
  install: (() => void) | null;
  search?: string;
  onSearch?: (value: string) => void;
  onOptions: () => void;
  onSignOut: () => void;
  onSelectTenant: (id: string) => void;
}) {
  const { session } = useAuth();
  const [menu, setMenu] = useState(false);
  const tenants = session?.tenants ?? [];
  const person = { address: session?.user.email ?? '', name: session?.user.displayName ?? null };
  return (
    <header className="mx-top">
      <div className="mx-brand">
        <img src="/logo.png" alt="" />
        <strong>{MAIL_APP_NAME}</strong>
      </div>
      {onSearch ? (
        <input
          className="mx-search"
          type="search"
          placeholder="Search"
          aria-label="Search mail"
          value={search ?? ''}
          onChange={(event) => onSearch(event.target.value)}
        />
      ) : (
        <span />
      )}
      <div className="mx-top-actions">
        {tenants.length > 1 ? (
          <select
            aria-label="Organisation"
            value={session?.organisation?.id ?? ''}
            onChange={(event) => onSelectTenant(event.target.value)}
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        ) : null}
        {install ? (
          <button
            className="mx-icon mx-install"
            type="button"
            title="Install app"
            onClick={install}
          >
            Install app
          </button>
        ) : null}
        <ThemeButton />
        <button
          className="mx-icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          onClick={onOptions}
        >
          ⚙
        </button>
        <div className="mx-account">
          <button
            type="button"
            className="mx-me"
            aria-label="Account"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <span className="mx-avatar" style={{ background: `hsl(${avatarHue(person)} 45% 42%)` }}>
              {initials(person)}
            </span>
          </button>
          {menu ? (
            <div className="mx-menu mx-menu-right" role="menu">
              <div className="mx-menu-who">
                <strong>{session?.user.displayName || session?.user.email}</strong>
                <span>{session?.user.email}</span>
                <span>{session?.organisation?.name}</span>
              </div>
              <Link role="menuitem" to="/account">
                Your account and password
              </Link>
              {canAdmin ? (
                <Link role="menuitem" to="/">
                  Administration
                </Link>
              ) : null}
              <button type="button" role="menuitem" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Reader({
  message,
  folders,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onAction,
}: {
  message: MessageDetail;
  folders: Array<{ name: string }>;
  onBack: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onAction: (action: BatchAction, folder?: string) => void;
}) {
  const [details, setDetails] = useState(false);
  const html =
    message.html ?? `<div style="white-space:pre-wrap">${escapeHtml(message.text)}</div>`;

  return (
    <article className="mx-reader">
      <div className="mx-actions" role="toolbar" aria-label="Message actions">
        <button type="button" className="mx-icon mx-back" aria-label="Back" onClick={onBack}>
          ←
        </button>
        <button type="button" onClick={onReply}>
          ↩ Reply
        </button>
        <button type="button" onClick={onReplyAll}>
          ↩↩ Reply all
        </button>
        <button type="button" onClick={onForward}>
          ↪ Forward
        </button>
        <span className="mx-sep" />
        <button type="button" onClick={() => onAction('delete')}>
          {message.folder === 'Trash' ? 'Delete forever' : 'Delete'}
        </button>
        {message.folder !== 'Archive' ? (
          <button type="button" onClick={() => onAction('move', 'Archive')}>
            Archive
          </button>
        ) : null}
        {message.folder === 'Junk' ? (
          <button type="button" onClick={() => onAction('move', 'INBOX')}>
            Not junk
          </button>
        ) : (
          <button type="button" onClick={() => onAction('move', 'Junk')}>
            Junk
          </button>
        )}
        <MoveSelect folders={folders} onMove={(name) => onAction('move', name)} />
        <button type="button" onClick={() => onAction(message.flagged ? 'unflag' : 'flag')}>
          {message.flagged ? 'Clear flag' : 'Flag'}
        </button>
        <button type="button" onClick={() => onAction(message.seen ? 'unread' : 'read')}>
          {message.seen ? 'Mark unread' : 'Mark read'}
        </button>
        <a
          className="mx-action-link"
          href={tenantLink(`/api/v1/mail/messages/${message.id}/raw`)}
          title="Download the original message (.eml)"
        >
          Download
        </a>
      </div>
      <h2 className="mx-reader-subject">{message.subject}</h2>
      <div className="mx-reader-from">
        <Avatar address={message.from} />
        <div>
          <strong>{who(message.from)}</strong>
          <button className="mx-link" type="button" onClick={() => setDetails(!details)}>
            To: {message.to.map(shortName).join('; ') || '(undisclosed)'}
            {message.cc.length ? `; Cc: ${message.cc.map(shortName).join('; ')}` : ''}
          </button>
          {details ? (
            <dl className="mx-headers">
              <dt>From</dt>
              <dd>{who(message.from)}</dd>
              {message.replyTo.length ? (
                <>
                  <dt>Reply to</dt>
                  <dd>{message.replyTo.map(who).join('; ')}</dd>
                </>
              ) : null}
              <dt>To</dt>
              <dd>{message.to.map(who).join('; ')}</dd>
              {message.cc.length ? (
                <>
                  <dt>Cc</dt>
                  <dd>{message.cc.map(who).join('; ')}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </div>
        <time
          className="mx-time"
          dateTime={new Date(message.sentAt ?? message.receivedAt).toISOString()}
        >
          {new Date(message.sentAt ?? message.receivedAt).toLocaleString([], {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </div>
      {message.attachments.length > 0 ? (
        <ul className="mx-attachments">
          {message.attachments.map((item) => (
            <li key={item.index}>
              <a href={tenantLink(`/api/v1/mail/messages/${message.id}/attachments/${item.index}`)}>
                {item.filename}
              </a>
              <span className="muted">{fileSize(item.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Sandboxed without scripts or same-origin access: the message cannot reach this page. */}
      <iframe
        className="mx-frame"
        title="Message body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={readingDocument(html)}
      />
    </article>
  );
}
