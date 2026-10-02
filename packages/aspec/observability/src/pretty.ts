import type { LogLevel } from './levels.js';

export interface PrettyOptions {
  /** ANSI colours. Default: true when stdout is a TTY and NO_COLOR is not set. */
  colors?: boolean;
}

const COLORS: Record<LogLevel, string> = {
  trace: '\u001b[90m',
  debug: '\u001b[36m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  fatal: '\u001b[35m',
};
const RESET = '\u001b[0m';
const DIM = '\u001b[2m';

export function defaultColors(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function stackOf(value: unknown): string | undefined {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { stack?: unknown }).stack === 'string'
  ) {
    return (value as { stack: string }).stack;
  }
  return undefined;
}

/**
 * Formats a sanitised record for humans: `HH:MM:SS.mmm LEVEL message key=value`, followed by
 * indented stacks for error fields and their causes. Development use only.
 */
export function formatPretty(
  record: Record<string, unknown>,
  level: LogLevel,
  time: number,
  colors: boolean,
): string {
  const d = new Date(time);
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const label = level.toUpperCase().padEnd(5);
  const msg = typeof record.msg === 'string' ? record.msg : '';
  let line = colors
    ? `${DIM}${ts}${RESET} ${COLORS[level]}${label}${RESET} ${msg}`
    : `${ts} ${label} ${msg}`;
  const stacks: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'msg' || key === 'time' || key === 'level') continue;
    const stack = stackOf(value);
    if (stack) {
      let current: unknown = value;
      let prefix = '';
      let guard = 0;
      while (current && guard < 10) {
        const s = stackOf(current);
        if (s) stacks.push(`${prefix}${s}`);
        current = (current as { cause?: unknown }).cause;
        prefix = 'Caused by: ';
        guard++;
      }
      const { stack: _stack, cause: _cause, ...rest } = value as Record<string, unknown>;
      line += ` ${key}=${JSON.stringify(rest)}`;
      continue;
    }
    line += ` ${colors ? DIM : ''}${key}=${colors ? RESET : ''}${typeof value === 'string' ? value : JSON.stringify(value)}`;
  }
  for (const s of stacks) line += `\n    ${s.replace(/\n/g, '\n    ')}`;
  return `${line}\n`;
}
