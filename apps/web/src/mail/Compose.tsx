import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteMessage,
  type MyMailbox,
  type Person,
  type SendInput,
  saveDraft,
  searchPeople,
  sendMessage,
} from '../api.js';
import { fileSize, htmlToText, sanitiseHtml, splitAddresses, toBase64 } from './format.js';

export interface ComposeAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentBase64: string;
}

/** What the composer opens with: a new message, a reply or forward, or a saved draft. */
export interface ComposeState {
  key: string;
  mailboxId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  inReplyTo?: string;
  references?: string[];
  attachments: ComposeAttachment[];
  draftId?: string;
  title: string;
}

const AUTOSAVE_MS = 3000;

function RecipientField({
  label,
  values,
  onChange,
  autoFocus,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<Person[]>([]);
  const [highlight, setHighlight] = useState(0);
  const id = `rcpt-${label.toLowerCase()}`;
  const field = useRef<HTMLInputElement>(null);

  // A new message starts in the To field.
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void searchPeople(query)
        .then((items) => {
          if (!live) return;
          setSuggestions(items.filter((item) => !values.includes(item.address)).slice(0, 8));
          setHighlight(0);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, values]);

  const commit = (raw: string) => {
    const added = splitAddresses(raw).map((item) => item.toLowerCase());
    if (added.length === 0) return;
    onChange([...values, ...added.filter((item) => !values.includes(item))]);
    setText('');
    setSuggestions([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((current) => (current + step + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === 'Tab') {
      const pick = suggestions[highlight];
      if (pick && event.key !== ',' && event.key !== ';') {
        event.preventDefault();
        commit(pick.address);
        return;
      }
      if (text.trim()) {
        if (event.key !== 'Tab') event.preventDefault();
        commit(text);
      }
      return;
    }
    if (event.key === 'Backspace' && !text && values.length > 0) {
      onChange(values.slice(0, -1));
    }
    if (event.key === 'Escape') setSuggestions([]);
  };

  return (
    <div className="mx-field mx-recipients">
      <label htmlFor={id}>{label}</label>
      <div className="mx-chips">
        {values.map((value) => (
          <span key={value} className="mx-chip">
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((item) => item !== value))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          ref={field}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (/[,;]/.test(pasted)) {
              event.preventDefault();
              commit(pasted);
            }
          }}
          onBlur={() => {
            // Leave time for a click on a suggestion first.
            setTimeout(() => {
              const current = field.current?.value ?? '';
              if (current.trim()) commit(current);
              setSuggestions([]);
            }, 150);
          }}
        />
      </div>
      {suggestions.length > 0 ? (
        <ul className="mx-suggest">
          {suggestions.map((item, index) => (
            <li key={item.address}>
              <button
                type="button"
                className={index === highlight ? 'active' : ''}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(item.address);
                }}
              >
                <strong>{item.name}</strong>
                <span>
                  {item.address}
                  {item.kind === 'group' ? ' (group)' : item.kind === 'shared' ? ' (shared)' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const FORMAT_BUTTONS: Array<{ command: string; label: string; title: string }> = [
  { command: 'bold', label: 'B', title: 'Bold (Ctrl+B)' },
  { command: 'italic', label: 'I', title: 'Italic (Ctrl+I)' },
  { command: 'underline', label: 'U', title: 'Underline (Ctrl+U)' },
  { command: 'strikeThrough', label: 'S', title: 'Strikethrough' },
  { command: 'insertUnorderedList', label: '•', title: 'Bullets' },
  { command: 'insertOrderedList', label: '1.', title: 'Numbering' },
  { command: 'removeFormat', label: 'Tx', title: 'Clear formatting' },
];

export function Compose({
  initial,
  mailboxes,
  onClose,
  onChanged,
}: {
  initial: ComposeState;
  mailboxes: MyMailbox[];
  /** Called after send, discard or close. */
  onClose: (result: 'sent' | 'discarded' | 'closed') => void;
  /** Called after a draft save so lists can refresh. */
  onChanged: () => void;
}) {
  const [state, setState] = useState(initial);
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const draftId = useRef<string | undefined>(initial.draftId);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const closed = useRef(false);

  const mailbox = mailboxes.find((item) => item.id === state.mailboxId) ?? mailboxes[0];
  const fromChoices = mailboxes
    .filter((item) => !item.operator || item.id === state.mailboxId)
    .flatMap((item) =>
      [item.primaryAddress, ...item.aliases].map((address) => ({ address, mailboxId: item.id })),
    );

  // The editor is uncontrolled; set its starting content once.
  useEffect(() => {
    if (editor.current) editor.current.innerHTML = sanitiseHtml(initial.html);
  }, [initial.html]);

  const input = useCallback((): SendInput => {
    const html = editor.current?.innerHTML ?? '';
    return {
      mailboxId: state.mailboxId,
      from: state.from,
      to: state.to,
      cc: state.cc,
      bcc: state.bcc,
      subject: state.subject,
      text: htmlToText(html),
      html,
      ...(state.inReplyTo ? { inReplyTo: state.inReplyTo } : {}),
      ...(state.references?.length ? { references: state.references } : {}),
      attachments: state.attachments.map((item) => ({
        filename: item.filename,
        contentType: item.contentType,
        contentBase64: item.contentBase64,
      })),
      ...(draftId.current ? { draftId: draftId.current } : {}),
    };
  }, [state]);

  const save = useCallback(async () => {
    if (saving.current) await saving.current;
    if (!dirty.current || closed.current) return;
    dirty.current = false;
    const run = (async () => {
      try {
        const saved = await saveDraft(input());
        draftId.current = saved.id;
        setStatus(
          `Draft saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
        );
        onChanged();
      } catch (err) {
        dirty.current = true;
        setStatus(`Draft not saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
  }, [input, onChanged]);

  const touch = () => {
    dirty.current = true;
    setStatus(null);
  };

  // Save a little after the last change, like Outlook.
  useEffect(() => {
    const timer = setInterval(() => {
      if (dirty.current && !sending) void save();
    }, AUTOSAVE_MS);
    return () => clearInterval(timer);
  }, [save, sending]);

  const update = (patch: Partial<ComposeState>) => {
    setState((current) => ({ ...current, ...patch }));
    touch();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const added = await Promise.all(
      Array.from(files).map(async (file) => ({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        contentBase64: await toBase64(file),
      })),
    );
    setState((current) => ({ ...current, attachments: [...current.attachments, ...added] }));
    touch();
  };

  const send = async () => {
    setError(null);
    if (state.to.length + state.cc.length + state.bcc.length === 0) {
      setError('Add at least one recipient.');
      return;
    }
    if (!state.subject.trim() && !window.confirm('Send this message without a subject?')) return;
    setSending(true);
    try {
      if (saving.current) await saving.current;
      closed.current = true;
      await sendMessage(input());
      onClose('sent');
    } catch (err) {
      closed.current = false;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const discard = async () => {
    if (saving.current) await saving.current;
    closed.current = true;
    if (draftId.current) {
      try {
        await deleteMessage(draftId.current);
      } catch {
        // Already gone (sent elsewhere or removed); nothing to undo.
      }
    }
    onClose('discarded');
  };

  const close = async () => {
    await save();
    closed.current = true;
    onClose('closed');
  };

  const format = (command: string) => {
    editor.current?.focus();
    document.execCommand(command);
    touch();
  };

  const link = () => {
    const url = window.prompt('Link address (https://...)');
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url.trim())) {
      setError('Links must start with https://, http:// or mailto:.');
      return;
    }
    editor.current?.focus();
    document.execCommand('createLink', false, url.trim());
    touch();
  };

  return (
    <form
      className="mx-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          void send();
        }
      }}
    >
      <div className="mx-compose-bar">
        <button className="btn" type="submit" disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => void discard()}>
          Discard
        </button>
        <label className="btn btn-ghost mx-attach">
          Attach
          <input
            type="file"
            multiple
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
        <span className="mx-status muted">{status}</span>
        <button className="btn btn-ghost" type="button" onClick={() => void close()}>
          Save and close
        </button>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mx-field">
        <label htmlFor="compose-from">From</label>
        <select
          id="compose-from"
          value={`${state.mailboxId}|${state.from}`}
          onChange={(event) => {
            const [mailboxId = state.mailboxId, from = state.from] = event.target.value.split('|');
            if (mailboxId !== state.mailboxId && draftId.current) {
              // The draft lives in the old mailbox; start a new one in the chosen mailbox.
              void deleteMessage(draftId.current).catch(() => undefined);
              draftId.current = undefined;
            }
            update({ mailboxId, from });
          }}
        >
          {fromChoices.map((item) => (
            <option
              key={`${item.mailboxId}|${item.address}`}
              value={`${item.mailboxId}|${item.address}`}
            >
              {item.address}
            </option>
          ))}
        </select>
      </div>
      <RecipientField
        label="To"
        values={state.to}
        autoFocus={state.to.length === 0}
        onChange={(to) => update({ to })}
      />
      {showCc ? (
        <>
          <RecipientField label="Cc" values={state.cc} onChange={(cc) => update({ cc })} />
          <RecipientField label="Bcc" values={state.bcc} onChange={(bcc) => update({ bcc })} />
        </>
      ) : (
        <button className="mx-link" type="button" onClick={() => setShowCc(true)}>
          Cc and Bcc
        </button>
      )}
      <div className="mx-field">
        <label htmlFor="compose-subject">Subject</label>
        <input
          id="compose-subject"
          value={state.subject}
          onChange={(event) => update({ subject: event.target.value })}
        />
      </div>
      {state.attachments.length > 0 ? (
        <ul className="mx-attachments">
          {state.attachments.map((item, index) => (
            <li key={`${item.filename}-${item.size}-${item.contentBase64.length}`}>
              <span>{item.filename}</span>
              <span className="muted">{fileSize(item.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${item.filename}`}
                onClick={() =>
                  update({ attachments: state.attachments.filter((_, i) => i !== index) })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mx-format" role="toolbar" aria-label="Formatting">
        {FORMAT_BUTTONS.map((item) => (
          <button
            key={item.command}
            type="button"
            title={item.title}
            onMouseDown={(event) => {
              event.preventDefault();
              format(item.command);
            }}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          title="Insert link"
          onMouseDown={(event) => {
            event.preventDefault();
            link();
          }}
        >
          Link
        </button>
      </div>
      <div
        ref={editor}
        className="mx-editor"
        contentEditable
        title="Message"
        suppressContentEditableWarning
        onInput={touch}
        onPaste={(event) => {
          // Paste as plain text so foreign markup (and anything unsafe) never enters the editor.
          event.preventDefault();
          document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
          touch();
        }}
      />
      {mailbox?.operator ? (
        <p className="notice">
          Sending from {mailbox.primaryAddress} through operator access is recorded in the audit
          log.
        </p>
      ) : null}
    </form>
  );
}
