import { mapError } from './map.js';
import { createRedactor, type Redactor } from './redact.js';

export interface StackFrame {
  function?: string;
  file?: string;
  line?: number;
  column?: number;
  /** The raw frame text when it could not be parsed. */
  raw?: string;
}

export interface DebugInfo {
  name: string;
  message: string;
  code?: string;
  status: number;
  category: string;
  operational: boolean;
  stack: StackFrame[];
  details?: unknown;
  cause?: DebugInfo | { value: unknown };
  errors?: DebugInfo[];
}

export interface DebugOptions {
  /** Redactor applied to messages and details. Default: `createRedactor()`. */
  redactor?: Redactor;
  /** Maximum nested causes. Default 5. */
  maxCauseDepth?: number;
  /** Maximum stack frames per error. Default 30. */
  maxFrames?: number;
}

const FRAME_WITH_FN = /^\s*at (?:async )?(.*?) \((.*):(\d+):(\d+)\)$/;
const FRAME_NO_FN = /^\s*at (?:async )?(.*):(\d+):(\d+)$/;

/** Parses a V8 stack string into frames. */
export function parseStack(stack: string | undefined, maxFrames = 30): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    if (!/^\s*at /.test(line)) continue;
    if (frames.length >= maxFrames) break;
    const a = FRAME_WITH_FN.exec(line);
    if (a) {
      frames.push({
        function: a[1] ?? '',
        file: a[2] ?? '',
        line: Number(a[3]),
        column: Number(a[4]),
      });
      continue;
    }
    const b = FRAME_NO_FN.exec(line);
    if (b) {
      frames.push({ file: b[1] ?? '', line: Number(b[2]), column: Number(b[3]) });
      continue;
    }
    frames.push({ raw: line.trim() });
  }
  return frames;
}

/**
 * Structured debugging information for logs: name, message, code, classification, parsed stack
 * frames, redacted details, the cause chain and AggregateError members. Never send it to
 * clients in production.
 */
export function toDebugJSON(err: unknown, options: DebugOptions = {}): DebugInfo {
  const redactor = options.redactor ?? createRedactor();
  const maxDepth = options.maxCauseDepth ?? 5;
  const maxFrames = options.maxFrames ?? 30;

  const walk = (value: unknown, depth: number, seen: Set<unknown>): DebugInfo => {
    seen.add(value);
    const mapped = mapError(value);
    const o = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const info: DebugInfo = {
      name:
        value instanceof Error ? value.name : typeof o.name === 'string' ? o.name : typeof value,
      message: redactor.string(mapped.internalMessage),
      status: mapped.status,
      category: mapped.category,
      operational: mapped.operational,
      stack: value instanceof Error ? parseStack(value.stack, maxFrames) : [],
    };
    if (typeof o.code === 'string') info.code = o.code;
    if (o.details !== undefined) info.details = redactor(o.details);
    const cause = value instanceof Error ? value.cause : o.cause;
    if (cause !== undefined && depth < maxDepth) {
      if (seen.has(cause)) info.cause = { value: '[Circular]' };
      else if (cause instanceof Error || (typeof cause === 'object' && cause !== null))
        info.cause = walk(cause, depth + 1, seen);
      else info.cause = { value: redactor(cause) };
    }
    if (value instanceof AggregateError && depth < maxDepth) {
      info.errors = value.errors
        .slice(0, 20)
        .filter((e) => !seen.has(e))
        .map((e) => walk(e, depth + 1, seen));
    }
    return info;
  };
  return walk(err, 0, new Set());
}
