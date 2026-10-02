import { configError } from './errors.js';

/** Log levels with pino-compatible numeric values. */
export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;
export type LogLevelSetting = LogLevel | 'silent';

export const LOG_LEVEL_NAMES: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LOG_LEVELS, value);
}

export function levelValue(level: LogLevelSetting, option = 'level'): number {
  if (level === 'silent') return Number.POSITIVE_INFINITY;
  if (!isLogLevel(level)) {
    throw configError(option, `must be one of ${LOG_LEVEL_NAMES.join(', ')}, silent`);
  }
  return LOG_LEVELS[level];
}
