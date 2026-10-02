import type { TracerLike } from './instrumentation.js';

export type { AttributeValue, SpanLike, TracerLike } from './instrumentation.js';

interface OtelApi {
  trace: { getTracer(name: string, version?: string): TracerLike };
}

/**
 * Returns an OpenTelemetry tracer from `@opentelemetry/api` (optional peer dependency) for
 * the `tracer` client option, or `undefined` when the package is not installed. Spans are
 * exported by whatever OpenTelemetry SDK the application registered.
 */
export async function loadOpenTelemetryTracer(
  options: { name?: string; version?: string } = {},
): Promise<TracerLike | undefined> {
  const specifier = '@opentelemetry/api';
  let api: OtelApi;
  try {
    const mod = (await import(specifier)) as Partial<OtelApi> & { default?: Partial<OtelApi> };
    const candidate = mod.trace ? mod : mod.default;
    if (!candidate?.trace || typeof candidate.trace.getTracer !== 'function') return undefined;
    api = candidate as OtelApi;
  } catch {
    return undefined;
  }
  return api.trace.getTracer(options.name ?? '@aspec/db', options.version);
}
