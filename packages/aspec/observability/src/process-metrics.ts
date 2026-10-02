import { monitorEventLoopDelay } from 'node:perf_hooks';
import { configError } from './errors.js';
import type { MetricsRegistry } from './metrics.js';

export interface ProcessMetricsOptions {
  /** Event loop delay sampling resolution in milliseconds. Default 10. */
  eventLoopResolutionMs?: number;
}

export interface ProcessMetrics {
  /** Stops event loop monitoring. The metrics stay registered with their last values. */
  stop(): void;
}

/**
 * Registers default process metrics (prom-client compatible names): CPU seconds, resident
 * memory, V8 heap, external memory, event loop delay percentiles from
 * `perf_hooks.monitorEventLoopDelay`, active resources (where `process.getActiveResourcesInfo`
 * exists), start time, uptime and Node.js version. Values refresh on every collection.
 */
export function registerProcessMetrics(
  registry: MetricsRegistry,
  options: ProcessMetricsOptions = {},
): ProcessMetrics {
  const resolution = options.eventLoopResolutionMs ?? 10;
  if (!Number.isInteger(resolution) || resolution < 1) {
    throw configError('eventLoopResolutionMs', 'must be a positive integer');
  }
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();
  let lastCpu = process.cpuUsage();

  const cpuUser = registry.counter({
    name: 'process_cpu_user_seconds_total',
    help: 'Total user CPU time spent in seconds.',
  });
  const cpuSystem = registry.counter({
    name: 'process_cpu_system_seconds_total',
    help: 'Total system CPU time spent in seconds.',
  });
  const cpuTotal = registry.counter({
    name: 'process_cpu_seconds_total',
    help: 'Total user and system CPU time spent in seconds.',
    collect() {
      const now = process.cpuUsage();
      const user = Math.max(0, now.user - lastCpu.user) / 1e6;
      const system = Math.max(0, now.system - lastCpu.system) / 1e6;
      lastCpu = now;
      cpuUser.inc(user);
      cpuSystem.inc(system);
      cpuTotal.inc(user + system);
    },
  });

  const rss = registry.gauge({
    name: 'process_resident_memory_bytes',
    help: 'Resident memory size in bytes.',
  });
  const heapTotal = registry.gauge({
    name: 'nodejs_heap_size_total_bytes',
    help: 'Process heap size from Node.js in bytes.',
  });
  const heapUsed = registry.gauge({
    name: 'nodejs_heap_size_used_bytes',
    help: 'Process heap size used from Node.js in bytes.',
  });
  const external = registry.gauge({
    name: 'nodejs_external_memory_bytes',
    help: 'Node.js external memory size in bytes.',
    collect() {
      const mem = process.memoryUsage();
      rss.set(mem.rss);
      heapTotal.set(mem.heapTotal);
      heapUsed.set(mem.heapUsed);
      external.set(mem.external);
    },
  });

  const startSeconds = Math.round((Date.now() - process.uptime() * 1000) / 1000);
  registry
    .gauge({
      name: 'process_start_time_seconds',
      help: 'Start time of the process since unix epoch in seconds.',
    })
    .set(startSeconds);
  const uptime = registry.gauge({
    name: 'process_uptime_seconds',
    help: 'Process uptime in seconds.',
    collect: () => uptime.set(process.uptime()),
  });

  const lagNames = [
    ['min', 'Minimum'],
    ['max', 'Maximum'],
    ['mean', 'Mean'],
    ['stddev', 'Standard deviation of'],
    ['p50', 'The 50th percentile of'],
    ['p90', 'The 90th percentile of'],
    ['p99', 'The 99th percentile of'],
  ] as const;
  const lag = Object.fromEntries(
    lagNames.map(([key, label]) => [
      key,
      registry.gauge({
        name: `nodejs_eventloop_delay_${key}_seconds`,
        help: `${label} event loop delay in seconds.`,
      }),
    ]),
  ) as Record<(typeof lagNames)[number][0], ReturnType<MetricsRegistry['gauge']>>;
  const delay = registry.gauge({
    name: 'nodejs_eventloop_delay_seconds',
    help: 'Mean event loop delay in seconds since the previous collection.',
    collect() {
      const toSeconds = (ns: number): number => (Number.isFinite(ns) ? ns / 1e9 : 0);
      const empty = histogram.count === 0;
      const values = {
        min: empty ? 0 : toSeconds(histogram.min),
        max: empty ? 0 : toSeconds(histogram.max),
        mean: empty ? 0 : toSeconds(histogram.mean),
        stddev: empty ? 0 : toSeconds(histogram.stddev),
        p50: empty ? 0 : toSeconds(histogram.percentile(50)),
        p90: empty ? 0 : toSeconds(histogram.percentile(90)),
        p99: empty ? 0 : toSeconds(histogram.percentile(99)),
      };
      for (const [key, gauge] of Object.entries(lag)) gauge.set(values[key as keyof typeof values]);
      delay.set(values.mean);
      histogram.reset();
    },
  });

  const getActive = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  if (typeof getActive === 'function') {
    const active = registry.gauge({
      name: 'nodejs_active_resources_total',
      help: 'Number of active resources keeping the event loop alive (process.getActiveResourcesInfo).',
      collect: () => active.set(getActive.call(process).length),
    });
  }

  const [major = '0', minor = '0', patch = '0'] = process.versions.node.split('.');
  registry
    .gauge({
      name: 'nodejs_version_info',
      help: 'Node.js version info.',
      labelNames: ['version', 'major', 'minor', 'patch'],
    })
    .set({ version: process.version, major, minor, patch }, 1);

  return {
    stop() {
      histogram.disable();
    },
  };
}
