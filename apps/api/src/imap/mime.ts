import addressparser from 'nodemailer/lib/addressparser/index.js';

/** A parsed MIME entity with byte ranges, enough for IMAP BODYSTRUCTURE and BODY[section]. */
export interface MimeNode {
  header: Buffer;
  body: Buffer;
  headers: Map<string, string[]>;
  type: string;
  subtype: string;
  params: Record<string, string>;
  children: MimeNode[];
  message: MimeNode | null;
}

function splitHeader(raw: Buffer): { header: Buffer; body: Buffer } {
  let index = raw.indexOf('\r\n\r\n');
  let skip = 4;
  const lf = raw.indexOf('\n\n');
  if (index === -1 || (lf !== -1 && lf < index)) {
    index = lf;
    skip = 2;
  }
  if (raw.length >= 2 && raw[0] === 13 && raw[1] === 10)
    return { header: raw.subarray(0, 2), body: raw.subarray(2) };
  if (index === -1) return { header: raw, body: Buffer.alloc(0) };
  return { header: raw.subarray(0, index + skip), body: raw.subarray(index + skip) };
}

export function parseHeaders(header: Buffer): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const unfolded = header.toString('binary').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }
  return map;
}

export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    params[key] = val;
  }
  return { value: (parts[0] ?? '').trim(), params };
}

export function parseMime(raw: Buffer, defaultType = 'text/plain'): MimeNode {
  const { header, body } = splitHeader(raw);
  const headers = parseHeaders(header);
  const ct = parseParams(headers.get('content-type')?.[0] ?? defaultType);
  const [type = 'text', subtype = 'plain'] = ct.value.toLowerCase().split('/');
  const node: MimeNode = {
    header,
    body,
    headers,
    type,
    subtype,
    params: ct.params,
    children: [],
    message: null,
  };
  if (type === 'multipart' && ct.params.boundary) {
    const childDefault = subtype === 'digest' ? 'message/rfc822' : 'text/plain';
    node.children = splitMultipart(body, ct.params.boundary).map((part) =>
      parseMime(part, childDefault),
    );
  } else if (type === 'message' && subtype === 'rfc822') {
    node.message = parseMime(body);
  }
  return node;
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delimiter = `--${boundary}`;
  const text = body.toString('binary');
  const parts: Buffer[] = [];
  let position = 0;
  let start = -1;
  while (position <= text.length) {
    const lineEnd = text.indexOf('\n', position);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(position, end).replace(/\r?\n$/, '');
    if (line.startsWith(delimiter)) {
      const rest = line.slice(delimiter.length).trimEnd();
      if (rest === '' || rest === '--') {
        if (start !== -1) {
          let partEnd = position;
          if (text[partEnd - 1] === '\n') partEnd -= 1;
          if (text[partEnd - 1] === '\r') partEnd -= 1;
          parts.push(body.subarray(start, Math.max(start, partEnd)));
        }
        if (rest === '--') break;
        start = end;
      }
    }
    if (lineEnd === -1) break;
    position = end;
  }
  return parts;
}

/** Resolves an IMAP part path ("1.2") to a node. */
export function findPart(root: MimeNode, path: number[]): MimeNode | null {
  let node: MimeNode | null = root;
  for (const index of path) {
    if (!node) return null;
    const container: MimeNode = node !== root && node.message ? node.message : node;
    if (container.type === 'multipart') node = container.children[index - 1] ?? null;
    else if (index === 1) node = container;
    else return null;
  }
  return node;
}

/** Quoted strings may not carry CR, LF, NUL or 8-bit characters; those go as literals. */
function needsLiteral(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13 || code > 126) return true;
  }
  return false;
}

export function quote(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return 'NIL';
  const text = Buffer.isBuffer(value) ? value.toString('binary') : value;
  if (needsLiteral(text)) {
    const bytes = Buffer.from(text, Buffer.isBuffer(value) ? 'binary' : 'utf8');
    return `{${bytes.length}}\r\n${bytes.toString('binary')}`;
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function paramList(params: Record<string, string>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return 'NIL';
  return `(${keys.map((key) => `${quote(key.toUpperCase())} ${quote(params[key] ?? '')}`).join(' ')})`;
}

function addressList(value: string | undefined): string {
  if (!value) return 'NIL';
  const parsed = addressparser(value, { flatten: true }) as Array<{
    name: string;
    address: string;
  }>;
  if (parsed.length === 0) return 'NIL';
  return `(${parsed
    .map((item) => {
      const [mailbox, host] = (item.address || '').split('@');
      return `(${quote(item.name || null)} NIL ${quote(mailbox || null)} ${quote(host || null)})`;
    })
    .join('')})`;
}

export function envelope(node: MimeNode): string {
  const h = (key: string) => node.headers.get(key)?.[0];
  const from = addressList(h('from'));
  const sender = h('sender') ? addressList(h('sender')) : from;
  const replyTo = h('reply-to') ? addressList(h('reply-to')) : from;
  return `(${quote(h('date') ?? null)} ${quote(h('subject') ?? null)} ${from} ${sender} ${replyTo} ${addressList(
    h('to'),
  )} ${addressList(h('cc'))} ${addressList(h('bcc'))} ${quote(h('in-reply-to') ?? null)} ${quote(
    h('message-id') ?? null,
  )})`;
}

function lineCount(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) if (byte === 10) count += 1;
  return count;
}

function disposition(node: MimeNode): string {
  const value = node.headers.get('content-disposition')?.[0];
  if (!value) return 'NIL';
  const parsed = parseParams(value);
  return `(${quote(parsed.value.toUpperCase())} ${paramList(parsed.params)})`;
}

export function bodyStructure(node: MimeNode, extended: boolean): string {
  if (node.type === 'multipart') {
    const children = node.children.length
      ? node.children.map((child) => bodyStructure(child, extended)).join('')
      : '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0)';
    const ext = extended ? ` ${paramList(node.params)} ${disposition(node)} NIL NIL` : '';
    return `(${children} ${quote(node.subtype.toUpperCase())}${ext})`;
  }
  const h = (key: string) => node.headers.get(key)?.[0] ?? null;
  const encoding = (h('content-transfer-encoding') ?? '7BIT').toUpperCase();
  let out = `${quote(node.type.toUpperCase())} ${quote(node.subtype.toUpperCase())} ${paramList(
    node.params,
  )} ${quote(h('content-id'))} ${quote(h('content-description'))} ${quote(encoding)} ${node.body.length}`;
  if (node.type === 'text') out += ` ${lineCount(node.body)}`;
  if (node.message) {
    out += ` ${envelope(node.message)} ${bodyStructure(node.message, extended)} ${lineCount(node.body)}`;
  }
  if (extended) out += ` ${quote(h('content-md5'))} ${disposition(node)} NIL NIL`;
  return `(${out})`;
}

/** Header subset for BODY[HEADER.FIELDS (...)] and .NOT. */
export function headerFields(header: Buffer, fields: string[], not: boolean): Buffer {
  const wanted = new Set(fields.map((field) => field.toLowerCase()));
  const text = header.toString('binary');
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let include = false;
  for (const line of lines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line)) {
      if (include) out.push(line);
      continue;
    }
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    include = not ? !wanted.has(name) : wanted.has(name);
    if (include) out.push(line);
  }
  return Buffer.from(`${out.join('\r\n')}${out.length ? '\r\n' : ''}\r\n`, 'binary');
}
