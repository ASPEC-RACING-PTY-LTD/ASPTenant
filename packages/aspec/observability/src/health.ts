import { configError, ObservabilityError, ObservabilityErrorCodes } from './errors.js';
import type { Clock, HealthCheckable, HealthCheckResult, LoggerLike } from './ports.js';

/** A check function. It receives an AbortSignal that fires when the check times out. */
export type HealthCheckFn = (context: { signal: AbortSignal }) => Promise<HealthCheckResult>;

export interface HealthCheckDefinition {
  check: HealthCheckable | HealthCheckFn;
  /** Critical checks gate readiness and turn /healthz to `error`. Default true. */
  critical?: boolean;
  /** Per-check timeout. Default: the health timeoutMs. */
  timeoutMs?: number;
  /** Reuse a result for this long. Default: the health cacheTtlMs. */
  cacheTtlMs?: number;
}

export type HealthCheckInput = HealthCheckable | HealthCheckFn | HealthCheckDefinition;

/**
 * How much a health response reveals:
 * - `none`: overall status only
 * - `basic`: plus per-check status, criticality and latency
 * - `full`: plus check details and error messages (internal use only)
 */
export type HealthDetailLevel = 'none' | 'basic' | 'full';
export type HealthStatus = 'ok' | 'degraded' | 'error' | 'draining';

export interface HealthCheckReport {
  status: 'ok' | 'error';
  critical: boolean;
  latencyMs: number;
  timedOut?: boolean;
  cached?: boolean;
  details?: Record<string, unknown>;
  error?: string;
}

export interface HealthReport {
  status: HealthStatus;
  timestamp?: string;
  uptimeSeconds?: number;
  checks?: Record<string, HealthCheckReport>;
}

export interface HealthResponse {
  /** 200 when healthy or degraded, 503 when a critical check fails or while draining. */
  statusCode: 200 | 503;
  body: HealthReport;
}

export interface HealthOptions {
  checks?: Record<string, HealthCheckInput>;
  /** Default per-check timeout. Default 2000 ms. */
  timeoutMs?: number;
  /** Default result cache. Default 0 (no cache). Concurrent calls always share one run. */
  cacheTtlMs?: number;
  /** Default detail level of responses. Default `basic`. */
  detail?: HealthDetailLevel;
  /** Receives a warning when a check changes from passing to failing and back. */
  logger?: LoggerLike;
  clock?: Clock;
}

export interface Health {
  /** Liveness: the process is running and serving. Never runs dependency checks. */
  liveness(options?: { detail?: HealthDetailLevel }): Promise<HealthResponse>;
  /** Readiness: not draining and every critical check passes. */
  readiness(options?: { detail?: HealthDetailLevel }): Promise<HealthResponse>;
  /** Every check, critical and non-critical. */
  health(options?: { detail?: HealthDetailLevel }): Promise<HealthResponse>;
  /** Runs checks (all, or the named ones) and returns full reports. */
  runChecks(names?: readonly string[]): Promise<Record<string, HealthCheckReport>>;
  addCheck(name: string, input: HealthCheckInput): void;
  removeCheck(name: string): boolean;
  /** Marks the process as draining: readiness fails from now on. */
  drain(): void;
  readonly draining: boolean;
  readonly detail: HealthDetailLevel;
}

interface RegisteredCheck {
  name: string;
  run: HealthCheckFn;
  critical: boolean;
  timeoutMs: number;
  cacheTtlMs: number;
  cached?: { report: HealthCheckReport; expiresAt: number };
  inflight?: Promise<HealthCheckReport>;
  lastOk?: boolean;
}

const CHECK_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const DETAIL_LEVELS: readonly HealthDetailLevel[] = ['none', 'basic', 'full'];

function isHealthCheckable(value: unknown): value is HealthCheckable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HealthCheckable).checkHealth === 'function'
  );
}

function isDefinition(value: unknown): value is HealthCheckDefinition {
  return typeof value === 'object' && value !== null && 'check' in value;
}

function nonNegativeInt(value: number, option: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw configError(option, 'must be a non-negative integer');
  return value;
}

export function isHealthDetailLevel(value: unknown): value is HealthDetailLevel {
  return typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value);
}

/**
 * Creates health, readiness and liveness checks over HealthCheckable dependencies and plain
 * async functions, with per-check timeouts, caching, in-flight deduplication and a draining
 * state for graceful shutdown.
 */
export function createHealth(options: HealthOptions = {}): Health {
  const timeoutMs = nonNegativeInt(options.timeoutMs ?? 2000, 'health.timeoutMs');
  if (timeoutMs === 0) throw configError('health.timeoutMs', 'must be greater than 0');
  const cacheTtlMs = nonNegativeInt(options.cacheTtlMs ?? 0, 'health.cacheTtlMs');
  const detail = options.detail ?? 'basic';
  if (!isHealthDetailLevel(detail))
    throw configError('health.detail', 'must be none, basic or full');
  const clock = options.clock ?? { now: () => Date.now() };
  const logger = options.logger;
  const checks = new Map<string, RegisteredCheck>();
  let draining = false;

  const register = (name: string, input: HealthCheckInput): void => {
    if (!CHECK_NAME.test(name))
      throw configError(`health.checks.${name}`, 'name must match [A-Za-z0-9_.:-]{1,64}');
    if (checks.has(name))
      throw configError(`health.checks.${name}`, 'a check with this name already exists');
    const def: HealthCheckDefinition = isDefinition(input) ? input : { check: input };
    let run: HealthCheckFn;
    if (isHealthCheckable(def.check)) {
      const target = def.check;
      run = () => target.checkHealth();
    } else if (typeof def.check === 'function') {
      run = def.check;
    } else {
      throw configError(
        `health.checks.${name}`,
        'must be a HealthCheckable, a function or { check }',
      );
    }
    const t =
      def.timeoutMs === undefined
        ? timeoutMs
        : nonNegativeInt(def.timeoutMs, `health.checks.${name}.timeoutMs`);
    if (t === 0) throw configError(`health.checks.${name}.timeoutMs`, 'must be greater than 0');
    checks.set(name, {
      name,
      run,
      critical: def.critical ?? true,
      timeoutMs: t,
      cacheTtlMs:
        def.cacheTtlMs === undefined
          ? cacheTtlMs
          : nonNegativeInt(def.cacheTtlMs, `health.checks.${name}.cacheTtlMs`),
    });
  };
  for (const [name, input] of Object.entries(options.checks ?? {})) register(name, input);

  const execute = async (check: RegisteredCheck): Promise<HealthCheckReport> => {
    const started = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new ObservabilityError(
            ObservabilityErrorCodes.healthCheckTimeout,
            `health check "${check.name}" timed out after ${check.timeoutMs} ms`,
          ),
        );
      }, check.timeoutMs);
    });
    let report: HealthCheckReport;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => check.run({ signal: controller.signal })),
        timeout,
      ]);
      const latencyMs = Math.round((performance.now() - started) * 1000) / 1000;
      const ok = typeof result === 'object' && result !== null && result.ok === true;
      report = {
        status: ok ? 'ok' : 'error',
        critical: check.critical,
        latencyMs: typeof result?.latencyMs === 'number' ? result.latencyMs : latencyMs,
      };
      if (result && typeof result.details === 'object' && result.details !== null)
        report.details = result.details;
      if (!ok) report.error = 'check reported not ok';
    } catch (error) {
      const latencyMs = Math.round((performance.now() - started) * 1000) / 1000;
      const timedOut =
        error instanceof ObservabilityError &&
        error.code === ObservabilityErrorCodes.healthCheckTimeout;
      report = {
        status: 'error',
        critical: check.critical,
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
      };
      if (timedOut) report.timedOut = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const ok = report.status === 'ok';
    if (check.lastOk !== undefined && check.lastOk !== ok) {
      if (ok) logger?.info({ check: check.name }, 'health check recovered');
      else
        logger?.warn(
          { check: check.name, error: report.error, critical: check.critical },
          'health check failing',
        );
    } else if (check.lastOk === undefined && !ok) {
      logger?.warn(
        { check: check.name, error: report.error, critical: check.critical },
        'health check failing',
      );
    }
    check.lastOk = ok;
    if (check.cacheTtlMs > 0) check.cached = { report, expiresAt: clock.now() + check.cacheTtlMs };
    return report;
  };

  const runOne = (check: RegisteredCheck): Promise<HealthCheckReport> => {
    if (check.cached && check.cached.expiresAt > clock.now()) {
      return Promise.resolve({ ...check.cached.report, cached: true });
    }
    if (check.inflight) return check.inflight;
    const p = execute(check).finally(() => {
      delete check.inflight;
    });
    check.inflight = p;
    return p;
  };

  const runMany = async (list: RegisteredCheck[]): Promise<Record<string, HealthCheckReport>> => {
    const reports = await Promise.all(list.map(runOne));
    const out: Record<string, HealthCheckReport> = {};
    list.forEach((c, i) => {
      out[c.name] = reports[i] as HealthCheckReport;
    });
    return out;
  };

  const render = (
    status: HealthStatus,
    reports: Record<string, HealthCheckReport> | undefined,
    level: HealthDetailLevel,
  ): HealthReport => {
    if (level === 'none') return { status };
    const body: HealthReport = { status, timestamp: new Date(clock.now()).toISOString() };
    if (level === 'full') body.uptimeSeconds = Math.round(process.uptime());
    if (reports) {
      const checksOut: Record<string, HealthCheckReport> = {};
      for (const [name, r] of Object.entries(reports)) {
        if (level === 'full') {
          checksOut[name] = r;
        } else {
          const basic: HealthCheckReport = {
            status: r.status,
            critical: r.critical,
            latencyMs: r.latencyMs,
          };
          if (r.timedOut) basic.timedOut = true;
          checksOut[name] = basic;
        }
      }
      body.checks = checksOut;
    }
    return body;
  };

  const levelOf = (requested: HealthDetailLevel | undefined): HealthDetailLevel => {
    if (requested === undefined) return detail;
    if (!isHealthDetailLevel(requested)) throw configError('detail', 'must be none, basic or full');
    return requested;
  };

  return {
    get draining() {
      return draining;
    },
    detail,
    async liveness(opts = {}) {
      const level = levelOf(opts.detail);
      return { statusCode: 200, body: render('ok', undefined, level) };
    },
    async readiness(opts = {}) {
      const level = levelOf(opts.detail);
      if (draining) return { statusCode: 503, body: render('draining', undefined, level) };
      const reports = await runMany([...checks.values()].filter((c) => c.critical));
      const failed = Object.values(reports).some((r) => r.status !== 'ok');
      return {
        statusCode: failed ? 503 : 200,
        body: render(failed ? 'error' : 'ok', reports, level),
      };
    },
    async health(opts = {}) {
      const level = levelOf(opts.detail);
      const reports = await runMany([...checks.values()]);
      const values = Object.values(reports);
      const criticalFailed = values.some((r) => r.critical && r.status !== 'ok');
      const anyFailed = values.some((r) => r.status !== 'ok');
      let status: HealthStatus = criticalFailed ? 'error' : anyFailed ? 'degraded' : 'ok';
      if (draining && status !== 'error') status = 'draining';
      return {
        statusCode: criticalFailed || draining ? 503 : 200,
        body: render(status, reports, level),
      };
    },
    runChecks(names) {
      const list = names
        ? names.map((n) => {
            const c = checks.get(n);
            if (!c) throw configError('names', `unknown health check "${n}"`);
            return c;
          })
        : [...checks.values()];
      return runMany(list);
    },
    addCheck: register,
    removeCheck: (name) => checks.delete(name),
    drain() {
      draining = true;
    },
  };
}
