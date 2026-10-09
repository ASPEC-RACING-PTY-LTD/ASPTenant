import type { Socket } from 'node:net';
import type { DirectoryMailbox } from '../directory/index.js';
import { type MessageFlags, normaliseFolderName, type UidRow } from '../mail/store.js';
import type { Platform } from '../platform.js';
import { withSystemTenant } from '../tenancy.js';
import {
  bodyStructure,
  envelope,
  findPart,
  headerFields,
  type MimeNode,
  parseMime,
} from './mime.js';
import {
  asBuffer,
  asString,
  decodeMailboxName,
  encodeMailboxName,
  internalDate,
  isSequenceSet,
  ParseError,
  parseCommand,
  parseImapDate,
  sequenceSet,
  type Token,
} from './parser.js';

/** An authenticated mail app login, bound to the tenant whose mailboxes it opens. */
export interface MailLogin {
  accountId: string;
  tenantId: string;
}

export interface MailAuthenticator {
  verify(email: string, password: string, ip: string): Promise<MailLogin | null>;
}

const CAPABILITIES =
  'IMAP4rev1 LITERAL+ SASL-IR AUTH=PLAIN IDLE NAMESPACE UIDPLUS MOVE SPECIAL-USE ID ENABLE UNSELECT CHILDREN';
const MAX_COMMAND = 60 * 1024 * 1024;
const SHARED = 'Shared';
const FLAG_NAMES: Record<keyof MessageFlags, string> = {
  seen: '\\Seen',
  flagged: '\\Flagged',
  answered: '\\Answered',
  draft: '\\Draft',
  deleted: '\\Deleted',
};

interface Selected {
  mailbox: DirectoryMailbox;
  folder: string;
  readOnly: boolean;
  uidValidity: number;
  rows: UidRow[];
}

interface View {
  mailbox: DirectoryMailbox;
  prefix: string;
}

class NoError extends Error {}

function flagsOf(row: MessageFlags): string {
  return (Object.keys(FLAG_NAMES) as (keyof MessageFlags)[])
    .filter((key) => row[key])
    .map((key) => FLAG_NAMES[key])
    .join(' ');
}

function flagPatch(tokens: Token[], value: boolean): Partial<MessageFlags> {
  const patch: Partial<MessageFlags> = {};
  for (const token of tokens) {
    const name = asString(token).toLowerCase();
    for (const [key, flag] of Object.entries(FLAG_NAMES)) {
      if (flag.toLowerCase() === name) patch[key as keyof MessageFlags] = value;
    }
  }
  return patch;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/%/g, '[^/]*')}$`, 'i');
}

export class ImapSession {
  private input = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private literal = 0;
  private queue: Promise<void> = Promise.resolve();
  private account: string | null = null;
  private tenant: string | null = null;
  private selected: Selected | null = null;
  private idle: { tag: string; timer: NodeJS.Timeout } | null = null;
  private authTag: string | null = null;
  private readonly mime = new Map<string, MimeNode>();

  private readonly socket: Socket;
  private readonly platform: Platform;
  private readonly auth: MailAuthenticator;
  private readonly ip: string;

  constructor(socket: Socket, platform: Platform, auth: MailAuthenticator, ip: string) {
    this.socket = socket;
    this.platform = platform;
    this.auth = auth;
    this.ip = ip;
    socket.setTimeout(30 * 60 * 1000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.stopIdle());
    this.send(`* OK [CAPABILITY ${CAPABILITIES}] ASPECTenant IMAP ready`);
  }

  private send(line: string | Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(typeof line === 'string' ? Buffer.from(`${line}\r\n`, 'binary') : line);
  }

  private onData(chunk: Buffer): void {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length > 0) {
      if (this.literal > 0) {
        if (this.input.length < this.literal) return;
        this.parts.push(this.input.subarray(0, this.literal));
        this.input = this.input.subarray(this.literal);
        this.literal = 0;
        continue;
      }
      const end = this.input.indexOf('\r\n');
      if (end === -1) {
        if (this.input.length > 64 * 1024) this.socket.destroy();
        return;
      }
      const line = this.input.subarray(0, end + 2);
      this.input = this.input.subarray(end + 2);
      if (this.idle) {
        if (line.toString().trim().toUpperCase() === 'DONE') this.endIdle();
        continue;
      }
      if (this.authTag) {
        const tag = this.authTag;
        this.authTag = null;
        this.enqueue(() => this.finishPlain(tag, line.toString().trim()));
        continue;
      }
      this.parts.push(line);
      const literal = /\{(\d+)(\+?)\}\r\n$/.exec(line.toString('binary'));
      if (literal) {
        this.literal = Number(literal[1]);
        const total = this.parts.reduce((sum, part) => sum + part.length, 0) + this.literal;
        if (total > MAX_COMMAND) {
          this.send('* BYE Command too large');
          this.socket.destroy();
          return;
        }
        if (!literal[2]) this.send('+ Ready');
        if (this.literal === 0) continue;
        continue;
      }
      const command = Buffer.concat(this.parts);
      this.parts = [];
      this.enqueue(() => this.run(command));
    }
  }

  private enqueue(task: () => Promise<void>): void {
    // After login every command runs bound to the session's tenant.
    const bound = () =>
      this.tenant && this.account
        ? withSystemTenant(this.platform, this.tenant, task, this.account)
        : task();
    this.queue = this.queue.then(bound).catch((error: unknown) => {
      this.platform.logger.warn({ err: error }, 'imap command failed');
    });
  }

  private async run(raw: Buffer): Promise<void> {
    let tag = '*';
    try {
      const command = parseCommand(raw);
      tag = command.tag;
      await this.dispatch(command.tag, command.name, command.args);
    } catch (error) {
      if (error instanceof ParseError) this.send(`${tag} BAD ${error.message}`);
      else if (error instanceof NoError) this.send(`${tag} NO ${error.message}`);
      else {
        this.platform.logger.warn({ err: error }, 'imap error');
        this.send(`${tag} NO Server error`);
      }
    }
  }

  private requireAuth(): string {
    if (!this.account) throw new ParseError('Not authenticated');
    return this.account;
  }

  private requireSelected(): Selected {
    if (!this.selected) throw new ParseError('No mailbox selected');
    return this.selected;
  }

  private async dispatch(tag: string, name: string, args: Token[]): Promise<void> {
    switch (name) {
      case 'CAPABILITY':
        this.send(`* CAPABILITY ${CAPABILITIES}`);
        break;
      case 'NOOP':
      case 'CHECK':
        if (this.selected) await this.sync(true);
        break;
      case 'LOGOUT':
        this.send('* BYE Logging out');
        this.send(`${tag} OK LOGOUT completed`);
        this.socket.end();
        return;
      case 'ID':
        this.send('* ID ("name" "ASPECTenant")');
        break;
      case 'ENABLE':
        this.send('* ENABLED');
        break;
      case 'LOGIN':
        await this.login(asString(args[0]), asString(args[1]));
        break;
      case 'AUTHENTICATE': {
        if (asString(args[0]).toUpperCase() !== 'PLAIN') throw new NoError('Unsupported mechanism');
        if (args[1] !== undefined) {
          await this.finishPlain(tag, asString(args[1]));
          return;
        }
        this.authTag = tag;
        this.send('+ ');
        return;
      }
      case 'NAMESPACE': {
        const shared = (await this.views()).some((view) => view.prefix);
        this.send(`* NAMESPACE (("" "/")) NIL ${shared ? `(("${SHARED}/" "/"))` : 'NIL'}`);
        break;
      }
      case 'LIST':
      case 'LSUB':
        await this.list(name, args);
        break;
      case 'STATUS':
        await this.status(args);
        break;
      case 'SELECT':
      case 'EXAMINE':
        await this.select(asString(args[0]), name === 'EXAMINE');
        this.send(
          `${tag} OK [${name === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${name} completed`,
        );
        return;
      case 'CREATE': {
        const target = await this.resolve(asString(args[0]));
        this.platformCheckWrite(target.mailbox);
        await this.platform.mail.messages.createFolder(
          target.mailbox.tenantId,
          target.mailbox.id,
          target.folder,
        );
        break;
      }
      case 'DELETE': {
        const target = await this.resolve(asString(args[0]));
        if (['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'].includes(target.folder)) {
          throw new NoError('System folders cannot be deleted');
        }
        await this.platform.mail.messages.deleteFolder(target.mailbox.id, target.folder);
        break;
      }
      case 'RENAME': {
        const from = await this.resolve(asString(args[0]));
        const to = await this.resolve(asString(args[1]));
        if (from.mailbox.id !== to.mailbox.id || from.folder === 'INBOX') {
          throw new NoError('Cannot rename this folder');
        }
        await this.platform.mail.messages.renameFolder(from.mailbox.id, from.folder, to.folder);
        break;
      }
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE': {
        const target = await this.resolve(asString(args[0]));
        await this.platform.mail.messages.setSubscribed(
          target.mailbox.id,
          target.folder,
          name === 'SUBSCRIBE',
        );
        break;
      }
      case 'APPEND':
        await this.append(tag, args);
        return;
      case 'IDLE':
        this.requireAuth();
        this.idle = {
          tag,
          timer: setInterval(() => {
            this.enqueue(() => (this.selected ? this.sync(true) : Promise.resolve()));
          }, 10_000),
        };
        this.send('+ idling');
        return;
      case 'CLOSE':
      case 'UNSELECT': {
        const selected = this.requireSelected();
        if (name === 'CLOSE' && !selected.readOnly) {
          await this.platform.mail.messages.expunge(selected.mailbox.id, selected.folder);
        }
        this.selected = null;
        break;
      }
      case 'EXPUNGE':
      case 'UID EXPUNGE': {
        const selected = this.requireSelected();
        if (selected.readOnly) throw new NoError('Mailbox is read-only');
        let uids: number[] | undefined;
        if (name === 'UID EXPUNGE') {
          const max = selected.rows.at(-1)?.uid ?? 0;
          const match = sequenceSet(asString(args[0]), max);
          uids = selected.rows.filter((row) => match(row.uid)).map((row) => row.uid);
        }
        const removed = await this.platform.mail.messages.expunge(
          selected.mailbox.id,
          selected.folder,
          uids,
        );
        this.emitExpunge(removed);
        break;
      }
      case 'FETCH':
      case 'UID FETCH':
        await this.fetch(args, name === 'UID FETCH');
        break;
      case 'STORE':
      case 'UID STORE':
        await this.store(args, name === 'UID STORE');
        break;
      case 'COPY':
      case 'UID COPY':
      case 'MOVE':
      case 'UID MOVE':
        await this.copy(tag, args, name.startsWith('UID'), name.endsWith('MOVE'));
        return;
      case 'SEARCH':
      case 'UID SEARCH':
        await this.search(args, name === 'UID SEARCH');
        break;
      default:
        throw new ParseError(`Unknown command ${name}`);
    }
    this.send(`${tag} OK ${name} completed`);
  }

  private platformCheckWrite(_mailbox: DirectoryMailbox): void {
    this.requireAuth();
  }

  private async login(email: string, password: string): Promise<void> {
    const login = await this.auth.verify(email, password, this.ip);
    if (!login) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw new NoError('[AUTHENTICATIONFAILED] Invalid credentials');
    }
    this.account = login.accountId;
    this.tenant = login.tenantId;
  }

  private async finishPlain(tag: string, payload: string): Promise<void> {
    try {
      if (payload === '*') throw new ParseError('Authentication cancelled');
      const [, user = '', pass = ''] = Buffer.from(payload, 'base64')
        .toString('utf8')
        .split('\u0000');
      await this.login(user, pass);
      this.send(`${tag} OK [CAPABILITY ${CAPABILITIES}] Authenticated`);
    } catch (error) {
      this.send(`${tag} NO ${error instanceof Error ? error.message : 'Failed'}`);
    }
  }

  private async views(): Promise<View[]> {
    const account = this.requireAuth();
    const mailboxes = await this.platform.directory.listAccessibleMailboxes(account);
    const own = mailboxes.find((item) => item.kind === 'user' && item.userId === account);
    return mailboxes.map((mailbox) => ({
      mailbox,
      prefix: mailbox === own ? '' : `${SHARED}/${mailbox.primaryAddress}/`,
    }));
  }

  private async resolve(encoded: string): Promise<{ mailbox: DirectoryMailbox; folder: string }> {
    const name = decodeMailboxName(encoded).replace(/\/+$/, '');
    const views = await this.views();
    const shared = views.filter((view) => view.prefix);
    for (const view of shared) {
      if (name.toLowerCase().startsWith(view.prefix.toLowerCase())) {
        return {
          mailbox: view.mailbox,
          folder: normaliseFolderName(name.slice(view.prefix.length)),
        };
      }
    }
    const own = views.find((view) => !view.prefix);
    if (!own || name.toLowerCase().startsWith(`${SHARED.toLowerCase()}/`)) {
      throw new NoError('[NONEXISTENT] No such mailbox');
    }
    return { mailbox: own.mailbox, folder: normaliseFolderName(name) };
  }

  private async list(command: string, args: Token[]): Promise<void> {
    let rest = args;
    let specialOnly = false;
    if (Array.isArray(rest[0])) {
      specialOnly = rest[0].some((item) => asString(item).toUpperCase() === 'SPECIAL-USE');
      rest = rest.slice(1);
    }
    const reference = decodeMailboxName(asString(rest[0]));
    const patternToken = rest[1];
    const patterns = (Array.isArray(patternToken) ? patternToken : [patternToken]).map((token) =>
      decodeMailboxName(asString(token)),
    );
    if (patterns.length === 1 && patterns[0] === '') {
      this.send(`* ${command} (\\Noselect) "/" ""`);
      return;
    }
    const entries: { name: string; attrs: string[] }[] = [];
    const views = await this.views();
    for (const view of views) {
      await this.platform.mail.messages.ensureFolders(view.mailbox.tenantId, view.mailbox.id);
      const folders = await this.platform.mail.messages.listFolders(view.mailbox.id);
      if (view.prefix) {
        if (!entries.some((entry) => entry.name === SHARED)) {
          entries.push({ name: SHARED, attrs: ['\\Noselect', '\\HasChildren'] });
        }
        entries.push({ name: view.prefix.slice(0, -1), attrs: ['\\Noselect', '\\HasChildren'] });
      }
      for (const folder of folders) {
        if (command === 'LSUB' && !folder.subscribed) continue;
        if (specialOnly && !folder.specialUse) continue;
        const hasChildren = folders.some((other) => other.name.startsWith(`${folder.name}/`));
        const attrs = [hasChildren ? '\\HasChildren' : '\\HasNoChildren'];
        if (folder.specialUse) attrs.push(folder.specialUse);
        entries.push({ name: view.prefix + folder.name, attrs });
      }
    }
    const regexes = patterns.map((pattern) => globToRegex(reference + pattern));
    for (const entry of entries) {
      if (!regexes.some((regex) => regex.test(entry.name))) continue;
      this.send(
        `* ${command} (${entry.attrs.join(' ')}) "/" "${encodeMailboxName(entry.name).replace(/"/g, '\\"')}"`,
      );
    }
  }

  private async status(args: Token[]): Promise<void> {
    const encoded = asString(args[0]);
    const target = await this.resolve(encoded);
    const folder = await this.platform.mail.messages.getFolder(target.mailbox.id, target.folder);
    if (!folder) throw new NoError('[NONEXISTENT] No such mailbox');
    const rows = await this.platform.mail.messages.uidRows(target.mailbox.id, target.folder);
    const items = (Array.isArray(args[1]) ? args[1] : [args[1]]).map((item) =>
      asString(item).toUpperCase(),
    );
    const values: string[] = [];
    for (const item of items) {
      if (item === 'MESSAGES') values.push(`MESSAGES ${rows.length}`);
      else if (item === 'RECENT') values.push('RECENT 0');
      else if (item === 'UIDNEXT') values.push(`UIDNEXT ${folder.uidNext}`);
      else if (item === 'UIDVALIDITY') values.push(`UIDVALIDITY ${folder.uidValidity}`);
      else if (item === 'UNSEEN') values.push(`UNSEEN ${rows.filter((row) => !row.seen).length}`);
    }
    this.send(`* STATUS "${encoded.replace(/"/g, '\\"')}" (${values.join(' ')})`);
  }

  private async select(encoded: string, readOnly: boolean): Promise<void> {
    this.selected = null;
    const target = await this.resolve(encoded);
    await this.platform.mail.messages.ensureFolders(target.mailbox.tenantId, target.mailbox.id);
    const folder = await this.platform.mail.messages.getFolder(target.mailbox.id, target.folder);
    if (!folder) throw new NoError('[NONEXISTENT] No such mailbox');
    const rows = await this.platform.mail.messages.uidRows(target.mailbox.id, folder.name);
    this.selected = {
      mailbox: target.mailbox,
      folder: folder.name,
      readOnly,
      uidValidity: folder.uidValidity,
      rows,
    };
    const firstUnseen = rows.findIndex((row) => !row.seen);
    this.send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
    this.send(
      '* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)] Flags permitted',
    );
    this.send(`* ${rows.length} EXISTS`);
    this.send('* 0 RECENT');
    if (firstUnseen >= 0) this.send(`* OK [UNSEEN ${firstUnseen + 1}] First unseen`);
    this.send(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`);
    this.send(`* OK [UIDNEXT ${folder.uidNext}] Predicted next UID`);
  }

  /** Reports changes made by other sessions or deliveries. */
  private async sync(full: boolean): Promise<void> {
    const selected = this.selected;
    if (!selected) return;
    const rows = await this.platform.mail.messages.uidRows(selected.mailbox.id, selected.folder);
    const byUid = new Map(rows.map((row) => [row.uid, row]));
    if (full) {
      const removed = selected.rows.filter((row) => !byUid.has(row.uid)).map((row) => row.uid);
      this.emitExpunge(removed);
      selected.rows.forEach((row, index) => {
        const next = byUid.get(row.uid);
        if (next && flagsOf(next) !== flagsOf(row)) {
          this.send(`* ${index + 1} FETCH (FLAGS (${flagsOf(next)}) UID ${row.uid})`);
          selected.rows[index] = next;
        }
      });
    }
    const max = selected.rows.at(-1)?.uid ?? 0;
    const added = rows.filter((row) => row.uid > max);
    if (added.length > 0) {
      selected.rows.push(...added);
      this.send(`* ${selected.rows.length} EXISTS`);
    }
  }

  private emitExpunge(uids: number[]): void {
    const selected = this.selected;
    if (!selected) return;
    const set = new Set(uids);
    for (let index = selected.rows.length - 1; index >= 0; index -= 1) {
      const row = selected.rows[index];
      if (row && set.has(row.uid)) {
        this.send(`* ${index + 1} EXPUNGE`);
        selected.rows.splice(index, 1);
      }
    }
  }

  private stopIdle(): void {
    if (this.idle) clearInterval(this.idle.timer);
  }

  private endIdle(): void {
    const idle = this.idle;
    if (!idle) return;
    clearInterval(idle.timer);
    this.idle = null;
    this.enqueue(async () => this.send(`${idle.tag} OK IDLE terminated`));
  }

  private matching(set: string, byUid: boolean): { row: UidRow; seq: number }[] {
    const selected = this.requireSelected();
    if (!isSequenceSet(set) && set !== '$') throw new ParseError('Bad sequence set');
    const max = byUid ? (selected.rows.at(-1)?.uid ?? 0) : selected.rows.length;
    const match = sequenceSet(set, max);
    const out: { row: UidRow; seq: number }[] = [];
    selected.rows.forEach((row, index) => {
      if (match(byUid ? row.uid : index + 1)) out.push({ row, seq: index + 1 });
    });
    return out;
  }

  private async mimeFor(id: string): Promise<{ raw: Buffer; node: MimeNode }> {
    const raw = (await this.platform.mail.messages.raw(id)) ?? Buffer.alloc(0);
    let node = this.mime.get(id);
    if (!node) {
      node = parseMime(raw);
      this.mime.set(id, node);
      if (this.mime.size > 50) this.mime.delete(this.mime.keys().next().value as string);
    }
    return { raw, node };
  }

  private async fetch(args: Token[], byUid: boolean): Promise<void> {
    const selected = this.requireSelected();
    const itemsToken = args[1];
    let items = (Array.isArray(itemsToken) ? itemsToken : [itemsToken]).map((item) =>
      asString(item),
    );
    const macro = items.length === 1 ? items[0]?.toUpperCase() : undefined;
    if (macro === 'ALL') items = ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'];
    if (macro === 'FAST') items = ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'];
    if (macro === 'FULL') items = ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'];
    if (byUid && !items.some((item) => item.toUpperCase() === 'UID')) items.unshift('UID');

    for (const { row, seq } of this.matching(asString(args[0]), byUid)) {
      const out: Buffer[] = [];
      const push = (text: string) => out.push(Buffer.from(text, 'binary'));
      let markSeen = false;
      const parts: (string | { label: string; data: Buffer })[] = [];
      for (const item of items) {
        const upper = item.toUpperCase();
        if (upper === 'UID') parts.push(`UID ${row.uid}`);
        else if (upper === 'FLAGS') parts.push(`FLAGS (${flagsOf(row)})`);
        else if (upper === 'INTERNALDATE')
          parts.push(`INTERNALDATE "${internalDate(row.receivedAt)}"`);
        else if (upper === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${row.sizeBytes}`);
        else if (upper === 'ENVELOPE')
          parts.push(`ENVELOPE ${envelope((await this.mimeFor(row.id)).node)}`);
        else if (upper === 'BODYSTRUCTURE' || upper === 'BODY') {
          parts.push(
            `${upper} ${bodyStructure((await this.mimeFor(row.id)).node, upper === 'BODYSTRUCTURE')}`,
          );
        } else if (upper === 'RFC822' || upper === 'RFC822.HEADER' || upper === 'RFC822.TEXT') {
          const { raw, node } = await this.mimeFor(row.id);
          const data =
            upper === 'RFC822' ? raw : upper === 'RFC822.HEADER' ? node.header : node.body;
          if (upper !== 'RFC822.HEADER') markSeen = true;
          parts.push({ label: upper, data });
        } else if (upper.startsWith('BODY[') || upper.startsWith('BODY.PEEK[')) {
          const peek = upper.startsWith('BODY.PEEK[');
          const open = item.indexOf('[');
          const close = item.lastIndexOf(']');
          const spec = item.slice(open + 1, close);
          const partial = /^<(\d+)\.(\d+)>$/.exec(item.slice(close + 1));
          let data = await this.section(row.id, spec);
          let label = `BODY[${spec}]`;
          if (partial) {
            const start = Number(partial[1]);
            data = data.subarray(start, start + Number(partial[2]));
            label += `<${start}>`;
          }
          if (!peek) markSeen = true;
          parts.push({ label, data });
        } else throw new ParseError(`Unsupported fetch item ${item}`);
      }
      if (markSeen && !row.seen && !selected.readOnly) {
        await this.platform.mail.messages.setFlags(row.id, { seen: true });
        row.seen = true;
        if (!items.some((item) => item.toUpperCase() === 'FLAGS'))
          parts.push(`FLAGS (${flagsOf(row)})`);
      }
      push(`* ${seq} FETCH (`);
      parts.forEach((part, index) => {
        if (index > 0) push(' ');
        if (typeof part === 'string') push(part);
        else {
          push(`${part.label} {${part.data.length}}\r\n`);
          out.push(part.data);
        }
      });
      push(')\r\n');
      this.send(Buffer.concat(out));
    }
  }

  private async section(id: string, spec: string): Promise<Buffer> {
    const { raw, node } = await this.mimeFor(id);
    let rest = spec.trim();
    const path: number[] = [];
    let match = /^(\d+)\.?/.exec(rest);
    while (match) {
      path.push(Number(match[1]));
      rest = rest.slice(match[0].length);
      match = /^(\d+)\.?/.exec(rest);
    }
    const upper = rest.toUpperCase();
    let target: MimeNode | null = node;
    if (path.length > 0) {
      target = findPart(node, path);
      if (!target) return Buffer.alloc(0);
      if (upper === '') return target.body;
      if (upper === 'MIME') return target.header;
      target = target.message;
      if (!target) return Buffer.alloc(0);
    } else if (upper === '') return raw;
    if (upper === 'HEADER') return target.header;
    if (upper === 'TEXT') return target.body;
    const fields = /^HEADER\.FIELDS(\.NOT)?\s*\((.*)\)$/.exec(upper);
    if (fields) {
      return headerFields(
        target.header,
        (fields[2] ?? '').split(/\s+/).filter(Boolean),
        Boolean(fields[1]),
      );
    }
    throw new ParseError(`Unsupported section ${spec}`);
  }

  private async store(args: Token[], byUid: boolean): Promise<void> {
    const selected = this.requireSelected();
    if (selected.readOnly) throw new NoError('Mailbox is read-only');
    const action = asString(args[1]).toUpperCase();
    const silent = action.endsWith('.SILENT');
    const flagTokens = Array.isArray(args[2]) ? args[2] : args.slice(2);
    for (const { row, seq } of this.matching(asString(args[0]), byUid)) {
      let patch: Partial<MessageFlags>;
      if (action.startsWith('+')) patch = flagPatch(flagTokens, true);
      else if (action.startsWith('-')) patch = flagPatch(flagTokens, false);
      else {
        const set = flagPatch(flagTokens, true);
        patch = {
          seen: false,
          flagged: false,
          answered: false,
          draft: false,
          deleted: false,
          ...set,
        };
      }
      await this.platform.mail.messages.setFlags(row.id, patch);
      Object.assign(row, patch);
      if (!silent)
        this.send(`* ${seq} FETCH (FLAGS (${flagsOf(row)})${byUid ? ` UID ${row.uid}` : ''})`);
    }
  }

  private async copy(tag: string, args: Token[], byUid: boolean, move: boolean): Promise<void> {
    const selected = this.requireSelected();
    if (move && selected.readOnly) throw new NoError('Mailbox is read-only');
    const target = await this.resolve(asString(args[1]));
    const folder = await this.platform.mail.messages.getFolder(target.mailbox.id, target.folder);
    if (!folder) throw new NoError('[TRYCREATE] No such mailbox');
    const matches = this.matching(asString(args[0]), byUid);
    const source: number[] = [];
    const dest: number[] = [];
    const sameMailbox = target.mailbox.id === selected.mailbox.id;
    for (const { row } of matches) {
      let uid: number;
      if (sameMailbox && move) uid = await this.platform.mail.messages.move(row.id, folder.name);
      else if (sameMailbox) uid = await this.platform.mail.messages.copy(row.id, folder.name);
      else {
        const raw = (await this.platform.mail.messages.raw(row.id)) ?? Buffer.alloc(0);
        const stored = await this.platform.mail.append(target.mailbox, folder.name, raw, {
          ...row,
          receivedAt: row.receivedAt,
        });
        uid = stored.uid;
        if (move) await this.platform.mail.messages.delete(row.id);
      }
      source.push(row.uid);
      dest.push(uid);
    }
    const copyUid = source.length
      ? `[COPYUID ${folder.uidValidity} ${source.join(',')} ${dest.join(',')}] `
      : '';
    if (move) {
      if (copyUid) this.send(`* OK ${copyUid}Moved`);
      this.emitExpunge(source);
      this.send(`${tag} OK ${byUid ? 'UID ' : ''}MOVE completed`);
    } else this.send(`${tag} OK ${copyUid}${byUid ? 'UID ' : ''}COPY completed`);
    if (sameMailbox && folder.name === selected.folder) await this.sync(false);
  }

  private async append(tag: string, args: Token[]): Promise<void> {
    const target = await this.resolve(asString(args[0]));
    const folder = await this.platform.mail.messages.getFolder(target.mailbox.id, target.folder);
    if (!folder) throw new NoError('[TRYCREATE] No such mailbox');
    let index = 1;
    let flags: Partial<MessageFlags> = {};
    let receivedAt = Date.now();
    const maybeFlags = args[index];
    if (Array.isArray(maybeFlags)) {
      flags = flagPatch(maybeFlags, true);
      index += 1;
    }
    const maybeDate = args[index + 1] !== undefined ? args[index] : undefined;
    if (maybeDate !== undefined && !Array.isArray(maybeDate)) {
      try {
        receivedAt = parseImapDate(asString(maybeDate));
      } catch {
        receivedAt = Date.now();
      }
      index += 1;
    }
    const raw = asBuffer(args[index]);
    if (raw.length === 0) throw new ParseError('Empty message');
    const stored = await this.platform.mail.append(target.mailbox, folder.name, Buffer.from(raw), {
      ...flags,
      receivedAt,
    });
    if (
      this.selected &&
      this.selected.mailbox.id === target.mailbox.id &&
      this.selected.folder === folder.name
    ) {
      await this.sync(false);
    }
    this.send(`${tag} OK [APPENDUID ${folder.uidValidity} ${stored.uid}] APPEND completed`);
  }

  private async search(args: Token[], byUid: boolean): Promise<void> {
    const selected = this.requireSelected();
    let tokens = args;
    if (typeof tokens[0] === 'string' && tokens[0].toUpperCase() === 'CHARSET')
      tokens = tokens.slice(2);
    const max = selected.rows.at(-1)?.uid ?? 0;
    const results: number[] = [];
    for (const [index, row] of selected.rows.entries()) {
      const context = new SearchContext(this.platform, row, index + 1, selected.rows.length, max);
      if (await evaluate(tokens, context)) results.push(byUid ? row.uid : index + 1);
    }
    this.send(`* SEARCH${results.length ? ` ${results.join(' ')}` : ''}`);
  }
}

class SearchContext {
  private meta: Awaited<ReturnType<Platform['mail']['messages']['get']>> | undefined;
  private rawText: string | undefined;

  readonly platform: Platform;
  readonly row: UidRow;
  readonly seq: number;
  readonly count: number;
  readonly maxUid: number;

  constructor(platform: Platform, row: UidRow, seq: number, count: number, maxUid: number) {
    this.platform = platform;
    this.row = row;
    this.seq = seq;
    this.count = count;
    this.maxUid = maxUid;
  }

  async message() {
    if (this.meta === undefined) this.meta = await this.platform.mail.messages.get(this.row.id);
    return this.meta;
  }

  async raw(): Promise<string> {
    if (this.rawText === undefined) {
      this.rawText = ((await this.platform.mail.messages.raw(this.row.id)) ?? Buffer.alloc(0))
        .toString('utf8')
        .toLowerCase();
    }
    return this.rawText;
  }
}

async function evaluate(tokens: Token[], context: SearchContext): Promise<boolean> {
  let index = 0;
  const next = async (): Promise<boolean> => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) return true;
    if (Array.isArray(token)) return evaluate(token, context);
    const key = asString(token).toUpperCase();
    const arg = () => {
      const value = tokens[index];
      index += 1;
      return asString(value);
    };
    const row = context.row;
    const day = (ms: number) => Math.floor(ms / 86_400_000);
    const contains = async (field: 'subject' | 'from' | 'to' | 'cc') => {
      const needle = arg().toLowerCase();
      const message = await context.message();
      if (!message) return false;
      if (field === 'subject') return message.subject.toLowerCase().includes(needle);
      const list = field === 'from' ? [message.from] : message[field];
      return list.some((item) =>
        `${item.name ?? ''} ${item.address}`.toLowerCase().includes(needle),
      );
    };
    switch (key) {
      case 'ALL':
        return true;
      case 'SEEN':
        return row.seen;
      case 'UNSEEN':
        return !row.seen;
      case 'FLAGGED':
        return row.flagged;
      case 'UNFLAGGED':
        return !row.flagged;
      case 'ANSWERED':
        return row.answered;
      case 'UNANSWERED':
        return !row.answered;
      case 'DELETED':
        return row.deleted;
      case 'UNDELETED':
        return !row.deleted;
      case 'DRAFT':
        return row.draft;
      case 'UNDRAFT':
        return !row.draft;
      case 'RECENT':
      case 'NEW':
        return false;
      case 'OLD':
        return true;
      case 'KEYWORD':
        arg();
        return false;
      case 'UNKEYWORD':
        arg();
        return true;
      case 'NOT':
        return !(await next());
      case 'OR': {
        const a = await next();
        const b = await next();
        return a || b;
      }
      case 'UID':
        return sequenceSet(arg(), context.maxUid)(row.uid);
      case 'LARGER':
        return row.sizeBytes > Number(arg());
      case 'SMALLER':
        return row.sizeBytes < Number(arg());
      case 'SINCE':
        return day(row.receivedAt) >= day(parseImapDate(arg()));
      case 'BEFORE':
        return day(row.receivedAt) < day(parseImapDate(arg()));
      case 'ON':
        return day(row.receivedAt) === day(parseImapDate(arg()));
      case 'SENTSINCE':
      case 'SENTBEFORE':
      case 'SENTON': {
        const target = day(parseImapDate(arg()));
        const message = await context.message();
        const sent = day(message?.sentAt ?? row.receivedAt);
        if (key === 'SENTSINCE') return sent >= target;
        if (key === 'SENTBEFORE') return sent < target;
        return sent === target;
      }
      case 'SUBJECT':
        return contains('subject');
      case 'FROM':
        return contains('from');
      case 'TO':
        return contains('to');
      case 'CC':
        return contains('cc');
      case 'BCC':
        arg();
        return false;
      case 'HEADER': {
        const name = arg().toLowerCase();
        const value = arg().toLowerCase();
        const raw = await context.raw();
        const header = raw.slice(
          0,
          raw.indexOf('\r\n\r\n') === -1 ? undefined : raw.indexOf('\r\n\r\n'),
        );
        return header
          .split(/\r?\n/)
          .some((line) => line.startsWith(`${name}:`) && line.includes(value));
      }
      case 'BODY':
      case 'TEXT':
        return (await context.raw()).includes(arg().toLowerCase());
      default:
        if (isSequenceSet(key)) return sequenceSet(key, context.count)(context.seq);
        throw new ParseError(`Unsupported search key ${key}`);
    }
  };
  while (index < tokens.length) {
    if (!(await next())) return false;
  }
  return true;
}
