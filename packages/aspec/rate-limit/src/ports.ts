// Structural ports copied verbatim from docs/architecture/integration-ports.md.

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms
  retryAfterMs?: number;
}

export interface RateLimiterLike {
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
}

export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface AuditEventInput {
  action: string; // namespaced, e.g. "auth.login.failed"
  outcome?: 'success' | 'failure' | 'denied';
  actor?: { id: string; type?: string; ip?: string; userAgent?: string };
  resource?: { type: string; id?: string };
  tenantId?: string;
  requestId?: string;
  changes?: { before?: unknown; after?: unknown };
  metadata?: Record<string, unknown>;
  category?: 'security' | 'data' | 'admin' | 'system';
}

export interface AuditSink {
  record(event: AuditEventInput): Promise<unknown>;
}

export interface Clock {
  now(): number;
} // epoch ms
