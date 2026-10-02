import { createReadStream } from 'node:fs';
import { type FileHandle, open, rename, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { canonicalJson } from '../canonical.js';
import { type ChainOptions, resolveChainKeys, verifyEvents } from '../chain.js';
import { AuditError } from '../errors.js';
import type { AuditEventSink } from '../store.js';
import type { AuditEvent, ChainHead, ChainVerificationReport } from '../types.js';

export interface JsonlFileSinkOptions {
  /** File path. Rotated files are `<path>.1` (newest) to `<path>.<maxFiles>` (oldest). */
  path: string;
  /** Rotate before a write would make the file larger than this. Default: no rotation. */
  maxBytes?: number;
  /** Rotated files kept. Older files are deleted. Default 5. */
  maxFiles?: number;
  /** fsync after every write for durability across power loss. Default false. */
  fsync?: boolean;
  /** File mode for new files. Default 0o600. */
  mode?: number;
}

export interface JsonlFileSink extends AuditEventSink {
  readonly path: string;
  /** Rotates the current file now. */
  rotate(): Promise<void>;
  recoverHeads(): Promise<ChainHead[]>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Files of a rotated log from oldest to newest. */
export async function listJsonlFiles(path: string, maxFiles = 5): Promise<string[]> {
  const files: string[] = [];
  for (let i = maxFiles; i >= 1; i--) {
    if (await exists(`${path}.${i}`)) files.push(`${path}.${i}`);
  }
  if (await exists(path)) files.push(path);
  return files;
}

export interface InvalidJsonlLine {
  file: string;
  line: number;
}

/** Reads events from JSON Lines files in order. Unparseable lines are reported, not thrown. */
export async function readJsonlEvents(
  files: string | readonly string[],
): Promise<{ events: AuditEvent[]; invalidLines: InvalidJsonlLine[] }> {
  const events: AuditEvent[] = [];
  const invalidLines: InvalidJsonlLine[] = [];
  for (const file of typeof files === 'string' ? [files] : files) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let n = 0;
    for await (const line of rl) {
      n++;
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (typeof e !== 'object' || e === null || typeof e.stream !== 'string')
          throw new Error('shape');
        events.push(e);
      } catch {
        invalidLines.push({ file, line: n });
      }
    }
  }
  return { events, invalidLines };
}

export interface VerifyJsonlOptions {
  chain?: ChainOptions;
  maxFiles?: number;
  /** Accept the first event of each stream without an anchor (older files were rotated away). */
  unanchored?: boolean;
}

/** Verifies the hash chains stored in a (possibly rotated) JSON Lines log. */
export async function verifyJsonlLog(
  path: string,
  options: VerifyJsonlOptions = {},
): Promise<{ ok: boolean; reports: ChainVerificationReport[]; invalidLines: InvalidJsonlLine[] }> {
  const keys = resolveChainKeys(options.chain);
  const files = await listJsonlFiles(path, options.maxFiles ?? 5);
  const { events, invalidLines } = await readJsonlEvents(files);
  const byStream = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const list = byStream.get(e.stream);
    if (list) list.push(e);
    else byStream.set(e.stream, [e]);
  }
  const reports = [...byStream.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([stream, list]) =>
      verifyEvents(list, { stream, keys, ...(options.unanchored ? { unanchored: true } : {}) }),
    );
  return { ok: invalidLines.length === 0 && reports.every((r) => r.ok), reports, invalidLines };
}

/** Appends events as canonical JSON lines, with optional size-based rotation and fsync. */
export function createJsonlFileSink(options: JsonlFileSinkOptions): JsonlFileSink {
  const path = options.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'jsonl path is required');
  }
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1024)) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'jsonl maxBytes must be an integer of at least 1024',
    );
  }
  const maxFiles = options.maxFiles ?? 5;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 1000) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'jsonl maxFiles must be an integer from 1 to 1000',
    );
  }
  const fsync = options.fsync ?? false;
  const mode = options.mode ?? 0o600;

  let handle: FileHandle | undefined;
  let size = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const ensureOpen = async (): Promise<FileHandle> => {
    if (!handle) {
      handle = await open(path, 'a', mode);
      size = (await handle.stat()).size;
    }
    return handle;
  };

  const doRotate = async (): Promise<void> => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (await exists(`${path}.${maxFiles}`)) await unlink(`${path}.${maxFiles}`);
    for (let i = maxFiles - 1; i >= 1; i--) {
      if (await exists(`${path}.${i}`)) await rename(`${path}.${i}`, `${path}.${i + 1}`);
    }
    if (await exists(path)) await rename(path, `${path}.1`);
    size = 0;
  };

  return {
    name: 'jsonl',
    path,
    write(events) {
      return serial(async () => {
        if (closed) throw new AuditError('AUDIT_SINK_CLOSED', 'the JSON Lines sink is closed');
        if (events.length === 0) return;
        const data = events.map((e) => `${canonicalJson(e)}\n`).join('');
        const bytes = Buffer.byteLength(data, 'utf8');
        await ensureOpen();
        if (maxBytes !== undefined && size > 0 && size + bytes > maxBytes) await doRotate();
        const h = await ensureOpen();
        await h.write(data);
        size += bytes;
        if (fsync) await h.sync();
      });
    },
    rotate: () => serial(doRotate),
    flush() {
      return serial(async () => {
        if (handle) await handle.sync();
      });
    },
    close() {
      return serial(async () => {
        closed = true;
        if (handle) {
          await handle.sync();
          await handle.close();
          handle = undefined;
        }
      });
    },
    recoverHeads() {
      return serial(async () => {
        const { events } = await readJsonlEvents(await listJsonlFiles(path, maxFiles));
        const heads = new Map<string, ChainHead>();
        for (const e of events) {
          const cur = heads.get(e.stream);
          if (
            typeof e.seq === 'number' &&
            typeof e.hash === 'string' &&
            (!cur || e.seq > cur.seq)
          ) {
            heads.set(e.stream, { stream: e.stream, seq: e.seq, hash: e.hash });
          }
        }
        return [...heads.values()];
      });
    },
  };
}
