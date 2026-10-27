import { type FormEvent, useState } from 'react';
import { type MailPreferences, saveMailPreferences } from '../api.js';

/** datetime-local value for an epoch time, in local time. */
function toLocalInput(value: number | null): string {
  if (value === null) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(value - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function MailOptions({
  preferences,
  notifications,
  onNotifications,
  onSaved,
  onClose,
}: {
  preferences: MailPreferences;
  notifications: boolean;
  onNotifications: (on: boolean) => void;
  onSaved: (preferences: MailPreferences) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(preferences);
  const [tab, setTab] = useState<'layout' | 'compose' | 'auto'>('layout');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reply = draft.autoReply;
  const setReply = (patch: Partial<MailPreferences['autoReply']>) =>
    setDraft({ ...draft, autoReply: { ...reply, ...patch } });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveMailPreferences(draft));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-dialog-backdrop">
      <form
        className="mx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mx-options-title"
        onSubmit={(event) => void onSubmit(event)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header>
          <h2 id="mx-options-title">Settings</h2>
          <button className="btn btn-ghost" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="mx-tabs" role="tablist">
          {(
            [
              ['layout', 'Layout'],
              ['compose', 'Compose and reply'],
              ['auto', 'Automatic replies'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}

        {tab === 'layout' ? (
          <div className="mx-options">
            <fieldset>
              <legend>Reading pane</legend>
              {(
                [
                  ['right', 'Show on the right'],
                  ['bottom', 'Show below the list'],
                  ['off', 'Hide it (open messages full size)'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="mx-check">
                  <input
                    type="radio"
                    name="reading-pane"
                    checked={draft.readingPane === value}
                    onChange={() => setDraft({ ...draft, readingPane: value })}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <label className="mx-check">
              <input
                type="checkbox"
                checked={draft.markReadOnOpen}
                onChange={(event) => setDraft({ ...draft, markReadOnOpen: event.target.checked })}
              />
              Mark messages as read when they are opened
            </label>
            <label className="mx-check">
              <input
                type="checkbox"
                checked={draft.groupByDate}
                onChange={(event) => setDraft({ ...draft, groupByDate: event.target.checked })}
              />
              Group the message list by date
            </label>
            <label className="mx-check">
              <input
                type="checkbox"
                checked={notifications}
                onChange={(event) => onNotifications(event.target.checked)}
              />
              Desktop notifications for new mail on this device
            </label>
          </div>
        ) : null}

        {tab === 'compose' ? (
          <div className="mx-options">
            <label htmlFor="mx-signature">Email signature</label>
            <textarea
              id="mx-signature"
              rows={6}
              value={draft.signature}
              onChange={(event) => setDraft({ ...draft, signature: event.target.value })}
            />
            <label className="mx-check">
              <input
                type="checkbox"
                checked={draft.signatureOnReplies}
                onChange={(event) =>
                  setDraft({ ...draft, signatureOnReplies: event.target.checked })
                }
              />
              Also add the signature to replies and forwards
            </label>
          </div>
        ) : null}

        {tab === 'auto' ? (
          <div className="mx-options">
            <label className="mx-check">
              <input
                type="checkbox"
                checked={reply.enabled}
                onChange={(event) => setReply({ enabled: event.target.checked })}
              />
              Turn on automatic replies
            </label>
            <div className="mx-two">
              <label>
                Start (optional)
                <input
                  type="datetime-local"
                  value={toLocalInput(reply.startsAt)}
                  onChange={(event) => setReply({ startsAt: fromLocalInput(event.target.value) })}
                />
              </label>
              <label>
                End (optional)
                <input
                  type="datetime-local"
                  value={toLocalInput(reply.endsAt)}
                  onChange={(event) => setReply({ endsAt: fromLocalInput(event.target.value) })}
                />
              </label>
            </div>
            <label>
              Subject prefix
              <input
                value={reply.subject}
                onChange={(event) => setReply({ subject: event.target.value })}
              />
            </label>
            <label htmlFor="mx-auto-internal">Reply to people in your organisation</label>
            <textarea
              id="mx-auto-internal"
              rows={5}
              value={reply.internalMessage}
              onChange={(event) => setReply({ internalMessage: event.target.value })}
            />
            <label className="mx-check">
              <input
                type="checkbox"
                checked={reply.external}
                onChange={(event) => setReply({ external: event.target.checked })}
              />
              Also reply to people outside your organisation
            </label>
            {reply.external ? (
              <textarea
                aria-label="Reply to people outside your organisation"
                rows={5}
                value={reply.externalMessage}
                onChange={(event) => setReply({ externalMessage: event.target.value })}
              />
            ) : null}
            <p className="muted">
              Each sender gets one automatic reply every four days. Mailing lists, bulk mail and
              other automatic messages are never answered.
            </p>
          </div>
        ) : null}

        <footer className="btn-row">
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </form>
    </div>
  );
}
