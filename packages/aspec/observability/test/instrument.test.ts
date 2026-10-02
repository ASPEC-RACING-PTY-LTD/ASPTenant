import { describe, expect, it } from 'vitest';
import { memoryDestination } from '../src/destinations.js';
import { createErrorCapture, createPerformance, startTimer } from '../src/instrument.js';
import { createLogger } from '../src/logger.js';
import { createMetricsRegistry } from '../src/metrics.js';
import { registerProcessMetrics } from '../src/process-metrics.js';

describe('instrumentation', () => {
  it('captureError logs and counts once per Error instance', () => {
    const dest = memoryDestination();
    const registry = createMetricsRegistry();
    const capture = createErrorCapture({
      logger: createLogger({ destination: dest, context: false }),
      registry,
    });
    const err = new Error('boom');
    (err as Error & { code?: string }).code = 'APP_FAIL';
    capture(err, { source: 'http' });
    capture(err, { source: 'http' });
    expect(dest.lines).toHaveLength(1);
    const counter = registry.getMetric('errors_total');
    expect(counter?.type).toBe('counter');
    if (counter?.type === 'counter') {
      expect(counter.get({ type: 'Error', code: 'APP_FAIL', source: 'http' })).toBe(1);
    }
  });

  it('timed and startTimer record durations', async () => {
    const registry = createMetricsRegistry();
    const perf = createPerformance({ registry });
    const ms = await perf.timed('work', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 1;
    });
    expect(ms).toBe(1);
    const t = startTimer();
    expect(t.elapsedMs()).toBeGreaterThanOrEqual(0);
    const op = perf.startTimer('manual');
    expect(op.end('success')).toBeGreaterThanOrEqual(0);
  });

  it('registers process metrics', async () => {
    const registry = createMetricsRegistry();
    registerProcessMetrics(registry);
    const text = await registry.metrics();
    expect(text).toMatch(
      /process_resident_memory_bytes|nodejs_heap_size_total_bytes|process_uptime_seconds/,
    );
  });
});
