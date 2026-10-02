import { describe, expect, it } from 'vitest';
import {
  createMetricsRegistry,
  DEFAULT_HTTP_DURATION_BUCKETS,
  escapeLabelValue,
  PROMETHEUS_CONTENT_TYPE,
} from '../src/metrics.js';

describe('metrics registry', () => {
  it('exposes Prometheus text 0.0.4 with HELP, TYPE and escaping', async () => {
    const registry = createMetricsRegistry({ prefix: 'app_' });
    const c = registry.counter({
      name: 'requests_total',
      help: 'Total requests\nwith newline',
      labelNames: ['route'],
    });
    c.inc({ route: 'a"b\\c' }, 2);
    const text = await registry.metrics();
    expect(registry.contentType).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(text).toContain('# HELP app_requests_total Total requests\\nwith newline');
    expect(text).toContain('# TYPE app_requests_total counter');
    expect(text).toContain(`route="${escapeLabelValue('a"b\\c')}"`);
    expect(text).toMatch(/app_requests_total\{route=".*"\} 2/);
  });

  it('records histogram buckets and enforces cardinality limits', async () => {
    const warnings: string[] = [];
    const registry = createMetricsRegistry({
      maxLabelSets: 2,
      logger: {
        debug() {},
        info() {},
        warn(obj, msg) {
          warnings.push(msg ?? JSON.stringify(obj));
        },
        error() {},
      },
    });
    const h = registry.histogram({
      name: 'latency_seconds',
      help: 'Latency',
      labelNames: ['route'],
      buckets: [0.1, 0.5, 1],
    });
    h.observe({ route: 'a' }, 0.2);
    h.observe({ route: 'b' }, 0.6);
    h.observe({ route: 'c' }, 0.05);
    expect(warnings.length).toBeGreaterThan(0);
    const snap = await registry.snapshot();
    const metric = snap.metrics.find((m) => m.name === 'latency_seconds');
    expect(metric?.type).toBe('histogram');
    expect(DEFAULT_HTTP_DURATION_BUCKETS.length).toBeGreaterThan(5);
  });

  it('supports gauges and JSON snapshot', async () => {
    const registry = createMetricsRegistry();
    const g = registry.gauge({ name: 'inflight', help: 'In flight', labelNames: ['m'] });
    g.inc({ m: 'GET' });
    g.dec({ m: 'GET' });
    g.set({ m: 'POST' }, 3);
    const snap = await registry.snapshot();
    expect(snap.metrics.some((m) => m.name === 'inflight')).toBe(true);
  });
});
