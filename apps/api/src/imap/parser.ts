/** IMAP command tokenizer (RFC 3501 section 9), including literals and bracketed atoms. */

export type Token = string | { text: Buffer } | Token[];

export class ParseError extends Error {}

export interface ParsedCommand {
  tag: string;
  name: string;
  args: Token[];
}

export function tokenize(input: Buffer): Token[] {
  let i = 0;
  const parseList = (close: number | null): Token[] => {
    const out: Token[] = [];
    while (i < input.length) {
      const c = input[i] as number;
      if (c === 32) {
        i += 1;
        continue;
      }
      if (c === 13 || c === 10) {
        i += 1;
        continue;
      }
      if (close !== null && c === close) {
        i += 1;
        return out;
      }
      if (c === 40) {
        i += 1;
        out.push(parseList(41));
        continue;
      }
      if (c === 34) {
        i += 1;
        const bytes: number[] = [];
        while (i < input.length && input[i] !== 34) {
          if (input[i] === 92) i += 1;
          bytes.push(input[i] as number);
          i += 1;
        }
        i += 1;
        out.push({ text: Buffer.from(bytes) });
        continue;
      }
      if (c === 123) {
        const end = input.indexOf(125, i);
        const size = Number.parseInt(
          input
            .subarray(i + 1, end)
            .toString()
            .replace('+', ''),
          10,
        );
        if (end === -1 || Number.isNaN(size)) throw new ParseError('Bad literal');
        i = end + 1;
        if (input[i] === 13) i += 1;
        if (input[i] === 10) i += 1;
        out.push({ text: input.subarray(i, i + size) });
        i += size;
        continue;
      }
      // Atom; brackets may contain spaces and parentheses (BODY[HEADER.FIELDS (A B)]<0.10>).
      const start = i;
      let depth = 0;
      while (i < input.length) {
        const ch = input[i] as number;
        if (ch === 91) depth += 1;
        else if (ch === 93) depth -= 1;
        else if (depth === 0 && (ch === 32 || ch === 40 || ch === 41 || ch === 13 || ch === 10)) {
          break;
        }
        i += 1;
      }
      out.push(input.subarray(start, i).toString('utf8'));
    }
    if (close !== null) throw new ParseError('Unclosed list');
    return out;
  };
  return parseList(null);
}

export function parseCommand(input: Buffer): ParsedCommand {
  const tokens = tokenize(input);
  const tag = tokens[0];
  const name = tokens[1];
  if (typeof tag !== 'string' || typeof name !== 'string') throw new ParseError('Missing command');
  let args = tokens.slice(2);
  let upper = name.toUpperCase();
  if (upper === 'UID') {
    const sub = args[0];
    if (typeof sub !== 'string') throw new ParseError('Missing UID command');
    upper = `UID ${sub.toUpperCase()}`;
    args = args.slice(1);
  }
  return { tag, name: upper, args };
}

export function asString(token: Token | undefined): string {
  if (token === undefined) throw new ParseError('Missing argument');
  if (typeof token === 'string') return token;
  if (Array.isArray(token)) throw new ParseError('Unexpected list');
  return token.text.toString('utf8');
}

export function asBuffer(token: Token | undefined): Buffer {
  if (token === undefined) throw new ParseError('Missing argument');
  if (typeof token === 'string') return Buffer.from(token);
  if (Array.isArray(token)) throw new ParseError('Unexpected list');
  return token.text;
}

/** Expands a sequence set ("1:4,7,9:*") against the highest value. */
export function sequenceSet(value: string, max: number): (n: number) => boolean {
  const ranges = value.split(',').map((part) => {
    const [a, b] = part.split(':');
    const parse = (v: string | undefined) => (v === '*' ? max : Number.parseInt(v ?? '', 10));
    const lo = parse(a);
    const hi = b === undefined ? lo : parse(b);
    if (Number.isNaN(lo) || Number.isNaN(hi)) throw new ParseError('Bad sequence set');
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

export function isSequenceSet(value: string): boolean {
  return /^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function internalDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** Parses an IMAP date ("1-Feb-1994") or date-time to epoch ms (UTC midnight for dates). */
export function parseImapDate(value: string): number {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}))?$/.exec(
    value.trim(),
  );
  if (!match) throw new ParseError('Bad date');
  const month = MONTHS.findIndex((m) => m.toLowerCase() === (match[2] ?? '').toLowerCase());
  const base = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  );
  const zone = match[7];
  if (!zone) return base;
  const sign = zone.startsWith('-') ? -1 : 1;
  const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60_000;
  return base - sign * offset;
}

/** IMAP mailbox names use modified UTF-7 (RFC 3501 5.1.3). */
export function encodeMailboxName(name: string): string {
  let out = '';
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    const bytes = Buffer.alloc(buffer.length * 2);
    for (let i = 0; i < buffer.length; i += 1) bytes.writeUInt16BE(buffer.charCodeAt(i), i * 2);
    out += `&${bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    buffer = '';
  };
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += char === '&' ? '&-' : char;
    } else buffer += char;
  }
  flush();
  return out;
}

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, chunk: string) => {
    if (chunk === '') return '&';
    const bytes = Buffer.from(chunk.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  });
}
