/**
 * Structural ports consumed by @aspec/errors, copied verbatim from
 * docs/architecture/integration-ports.md.
 */

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ErrorLike {
  name: string;
  message: string;
  code?: string; // UPPER_SNAKE, module-prefixed
  status?: number; // HTTP status hint
  expose?: boolean; // message is safe to show to clients
  details?: unknown; // safe structured details (e.g. validation issues)
}

export interface Clock {
  now(): number;
} // epoch ms
export type IdGenerator = () => string;
