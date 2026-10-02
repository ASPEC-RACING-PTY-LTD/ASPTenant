// Structural ports copied verbatim from docs/architecture/integration-ports.md.

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface HealthCheckable {
  checkHealth(): Promise<HealthCheckResult>;
}

export interface Clock {
  now(): number;
} // epoch ms
