import { describe, expect, it } from 'vitest';
import { createHealth } from '../src/health.js';
import { installGracefulShutdown } from '../src/shutdown.js';

describe('health', () => {
  it('reports failing and slow checks', async () => {
    const health = createHealth({
      timeoutMs: 50,
      detail: 'full',
      checks: {
        ok: async () => ({ ok: true }),
        fail: async () => ({ ok: false, details: { reason: 'down' } }),
        slow: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return { ok: true };
        },
      },
    });
    const report = await health.health();
    expect(report.statusCode).toBeGreaterThanOrEqual(500);
    const body = report.body as { status: string; checks: Record<string, { status: string }> };
    expect(body.checks.ok?.status).toBe('ok');
    expect(body.checks.fail?.status).toBe('error');
    expect(body.checks.slow?.status).toBe('error');
  });

  it('fails readiness while draining', async () => {
    const health = createHealth({
      checks: { db: async () => ({ ok: true }) },
    });
    expect((await health.readiness()).statusCode).toBe(200);
    health.drain();
    const ready = await health.readiness();
    expect(ready.statusCode).toBeGreaterThanOrEqual(500);
    const live = await health.liveness();
    expect(live.statusCode).toBe(200);
  });

  it('marks readiness false during graceful shutdown', async () => {
    const health = createHealth({ checks: { ok: async () => ({ ok: true }) } });
    const shutdown = installGracefulShutdown(health, {
      signals: [],
      drainDelayMs: 10,
      timeoutMs: 100,
      exit: false,
      onShutdown: async () => {},
    });
    const p = shutdown.shutdown('test');
    expect((await health.readiness()).statusCode).toBeGreaterThanOrEqual(500);
    expect(await p).toBe(0);
    shutdown.dispose();
  });
});
