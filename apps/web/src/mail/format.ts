import type { MailAddress, MessageDetail } from '../api.js';

/**
 * The mail app's name. It is configurable so an installation can brand it; set
 * VITE_MAIL_APP_NAME at build time to change it.
 */
export const MAIL_APP_NAME: string = import.meta.env.VITE_MAIL_APP_NAME || 'Mail';

const FOLDER_LABELS: Record<string, string> = {
  INBOX: 'Inbox',
  Drafts: 'Drafts',
  Sent: 'Sent Items',
  Archive: 'Archive',
  Junk: 'Junk Email',
  Trash: 'Deleted Items',
};

/** System folders in the order Outlook shows them; custom folders follow alphabetically. */
export const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash'];

export const folderLabel = (name: string) => FOLDER_LABELS[name] ?? name.split('/').pop() ?? name;
export const folderDepth = (name: string) => name.split('/').length - 1;
export const isSystemFolder = (name: string) => SYSTEM_ORDER.includes(name);

export function who(address: MailAddress | undefined): string {
  if (!address) return '';
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function shortName(address: MailAddress | undefined): string {
  if (!address) return '';
  return address.name || address.address;
}

export function initials(address: MailAddress | undefined): string {
  const source = shortName(address).replace(/<.*>/, '').trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[1]?.[0] ?? '') : '');
  return letters.toUpperCase() || '?';
}

/** A stable colour per sender for the avatar circle. */
export function avatarHue(address: MailAddress | undefined): number {
  let hash = 0;
  for (const char of address?.address ?? '') hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function listTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const days = (now.getTime() - timestamp) / 86_400_000;
  if (days < 7) {
    return date.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** List group heading like Outlook: Today, Yesterday, This week, Last week, then month. */
export function dateGroup(timestamp: number, now = new Date()): string {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (timestamp >= startOfDay) return 'Today';
  if (timestamp >= startOfDay - day) return 'Yesterday';
  const weekday = (now.getDay() + 6) % 7;
  const startOfWeek = startOfDay - weekday * day;
  if (timestamp >= startOfWeek) return 'This week';
  if (timestamp >= startOfWeek - 7 * day) return 'Last week';
  const date = new Date(timestamp);
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'long' });
  }
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/** Plain text of composed HTML, for the text part every message also carries. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of Array.from(doc.querySelectorAll('br'))) br.replaceWith('\n');
  for (const block of Array.from(doc.querySelectorAll('p, div, li, blockquote, h1, h2, h3'))) {
    block.append('\n');
  }
  for (const link of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    if (href && href !== link.textContent) link.append(` (${href})`);
  }
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  's',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'u',
  'ul',
]);
const ALLOWED_ATTRIBUTES = new Set(['href', 'color', 'style']);

/**
 * Keeps only simple formatting so HTML from a stored draft can be edited in this page safely:
 * no scripts, event handlers, frames, forms, images or javascript: links.
 */
export function sanitiseHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const clean = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math'].includes(tag)) {
          child.remove();
        } else {
          clean(child);
          child.replaceWith(...Array.from(child.childNodes));
        }
        continue;
      }
      for (const attribute of Array.from(child.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        const unsafe =
          !ALLOWED_ATTRIBUTES.has(name) ||
          (name === 'href' && !/^(https?:|mailto:)/i.test(value)) ||
          (name === 'style' && /url\(|expression|javascript:/i.test(value));
        if (unsafe) child.removeAttribute(attribute.name);
      }
      if (tag === 'a') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      clean(child);
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

/** The original message quoted under a reply or forward, as composer HTML. */
export function quotedHtml(message: MessageDetail, forward: boolean): string {
  const date = new Date(message.sentAt ?? message.receivedAt).toLocaleString();
  const lines = [
    `<b>From:</b> ${escapeHtml(who(message.from))}`,
    `<b>Sent:</b> ${escapeHtml(date)}`,
    `<b>To:</b> ${escapeHtml(message.to.map(who).join('; '))}`,
    ...(message.cc.length ? [`<b>Cc:</b> ${escapeHtml(message.cc.map(who).join('; '))}`] : []),
    `<b>Subject:</b> ${escapeHtml(message.subject)}`,
  ];
  const heading = forward ? '<p>---------- Forwarded message ----------</p>' : '';
  return `<br><br><hr>${heading}<div>${lines.join('<br>')}</div><br><blockquote>${textToHtml(message.text)}</blockquote>`;
}

/**
 * Wraps message HTML for the sandboxed reading frame: no scripts, remote images allowed. The
 * body stays light in dark mode because senders design their HTML for a white page.
 */
export function readingDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:"><base target="_blank"><style>html{background:#ffffff}body{font-family:"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5;margin:0;padding:12px;word-wrap:break-word;color:#1b2430;background:#ffffff}img{max-width:100%;height:auto}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:2px solid #c4ccd6}</style></head><body>${html}</body></html>`;
}

export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .map((item) => item.match(/<([^>]+)>/)?.[1] ?? item)
    .filter(Boolean);
}
