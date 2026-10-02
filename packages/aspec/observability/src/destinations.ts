import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { configError, ObservabilityError, ObservabilityErrorCodes } from './errors.js';

/** Where log lines go. Every line passed to write ends with `\n`. */
export interface LogDestination {
  write(line: string): void;
  /** Writes buffered lines synchronously. */
  flush?(): void;
  /** Flushes and releases resources. Later writes are dropped. */
  close?(): void;
}

export interface WritableLike {
  write(chunk: string): unknown;
}

/** Writes each line to process.stdout. */
export function stdoutDestination(): LogDestination {
  return { write: (line) => void process.stdout.write(line) };
}

/** Writes each line to process.stderr. */
export function stderrDestination(): LogDestination {
  return { write: (line) => void process.stderr.write(line) };
}

/** Writes each line to any object with a `write(string)` method (a Node stream, a socket). */
export function streamDestination(stream: WritableLike): LogDestination {
  if (!stream || typeof stream.write !== 'function') {
    throw configError('destination', 'stream must have a write(chunk) method');
  }
  return { write: (line) => void stream.write(line) };
}

export interface FileDestinationOptions {
  /** Flush when this many characters are buffered. Default 65536. */
  bufferSize?: number;
  /** Flush buffered lines at this interval. Default 1000 ms. 0 disables the timer. */
  flushIntervalMs?: number;
  /** Create the parent directory. Default true. */
  mkdir?: boolean;
  /** File mode for a newly created file. Default 0o640. */
  mode?: number;
  /** Called when a write fails. Default: one message to stderr per failure kind. */
  onError?: (error: Error) => void;
}

export interface FileDestination extends LogDestination {
  flush(): void;
  close(): void;
  readonly path: string;
}

/**
 * Appends lines to a file with buffered writes. The buffer is bounded (flushed when it reaches
 * bufferSize), flushed on an unref'd interval, and flushed synchronously on process exit so
 * the final lines (including a fatal error) reach disk.
 */
export function fileDestination(
  path: string,
  options: FileDestinationOptions = {},
): FileDestination {
  if (typeof path !== 'string' || path.length === 0) {
    throw configError('destination.path', 'must be a non-empty file path');
  }
  const bufferSize = options.bufferSize ?? 65_536;
  if (!Number.isInteger(bufferSize) || bufferSize < 0) {
    throw configError('destination.bufferSize', 'must be a non-negative integer');
  }
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  if (!Number.isInteger(flushIntervalMs) || flushIntervalMs < 0) {
    throw configError('destination.flushIntervalMs', 'must be a non-negative integer');
  }
  if (options.mkdir !== false) mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', options.mode ?? 0o640);
  let buffer: string[] = [];
  let buffered = 0;
  let closed = false;
  let reportedClosed = false;
  const onError =
    options.onError ??
    ((error: Error) => {
      process.stderr.write(`@aspec/observability: log file write failed: ${error.message}\n`);
    });

  const flush = (): void => {
    if (buffer.length === 0 || closed) return;
    const data = Buffer.from(buffer.join(''), 'utf8');
    buffer = [];
    buffered = 0;
    try {
      let offset = 0;
      while (offset < data.length) {
        offset += writeSync(fd, data, offset, data.length - offset);
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const onExit = (): void => flush();
  process.on('exit', onExit);
  const timer = flushIntervalMs > 0 ? setInterval(flush, flushIntervalMs) : undefined;
  timer?.unref();

  return {
    path,
    write(line) {
      if (closed) {
        if (!reportedClosed) {
          reportedClosed = true;
          onError(
            new ObservabilityError(
              ObservabilityErrorCodes.destinationClosed,
              'log file destination is closed; lines are dropped',
            ),
          );
        }
        return;
      }
      buffer.push(line);
      buffered += line.length;
      if (buffered >= bufferSize) flush();
    },
    flush,
    close() {
      if (closed) return;
      flush();
      closed = true;
      if (timer) clearInterval(timer);
      process.removeListener('exit', onExit);
      try {
        closeSync(fd);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export interface MemoryDestination extends LogDestination {
  /** Raw lines, oldest first. */
  readonly lines: string[];
  /** Parsed JSON records (lines that are not JSON are skipped). */
  records(): Record<string, unknown>[];
  clear(): void;
}

/** Keeps lines in memory (bounded, oldest dropped first). Intended for tests. */
export function memoryDestination(options: { maxLines?: number } = {}): MemoryDestination {
  const maxLines = options.maxLines ?? 10_000;
  const lines: string[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
      if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    },
    records() {
      const out: Record<string, unknown>[] = [];
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
        } catch {
          // Pretty-printed lines are not JSON; records() only returns structured lines.
        }
      }
      return out;
    },
    clear() {
      lines.length = 0;
    },
  };
}
