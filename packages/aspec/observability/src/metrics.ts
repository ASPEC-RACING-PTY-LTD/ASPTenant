import { configError, ObservabilityError, ObservabilityErrorCodes } from './errors.js';
import type { Clock, LoggerLike } from './ports.js';

export type MetricType = 'counter' | 'gauge' | 'histogram';
export type LabelValue = string | number | boolean;
export type LabelValues = Readonly<Record<string, LabelValue>>;

/** Content-Type of the Prometheus text exposition format 0.0.4. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Request duration buckets in seconds, as advised by the OpenTelemetry HTTP semantic
 * conventions for `http.server.request.duration`.
 */
export const DEFAULT_HTTP_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** Body size buckets in bytes (100 B to 100 MB). */
export const DEFAULT_SIZE_BUCKETS: readonly number[] = [
  100, 1000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000,
];

export const DEFAULT_MAX_LABEL_SETS = 1000;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function exponentialBuckets(start: number, factor: number, count: number): number[] {
  if (!(start > 0) || !(factor > 1) || !Number.isInteger(count) || count < 1) {
    throw configError('buckets', 'exponentialBuckets needs start > 0, factor > 1 and count >= 1');
  }
  const out: number[] = [];
  for (let i = 0, v = start; i < count; i++, v *= factor) out.push(Number(v.toPrecision(12)));
  return out;
}

export function linearBuckets(start: number, width: number, count: number): number[] {
  if (!Number.isFinite(start) || !(width > 0) || !Number.isInteger(count) || count < 1) {
    throw configError('buckets', 'linearBuckets needs a finite start, width > 0 and count >= 1');
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Number((start + i * width).toPrecision(12)));
  return out;
}

export interface MetricOptions {
  /** Metric name without the registry prefix. `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
  name: string;
  help: string;
  labelNames?: readonly string[];
  /** Maximum distinct label sets; new sets beyond it are dropped with a warning. */
  maxLabelSets?: number;
  /** Called before every collection (exposition, snapshot, bridges) to refresh values. */
  collect?: () => void | Promise<void>;
}

export interface HistogramOptions extends MetricOptions {
  /** Upper bounds, strictly increasing; +Inf is implicit. Default DEFAULT_HTTP_DURATION_BUCKETS. */
  buckets?: readonly number[];
}

export interface BoundCounter {
  inc(value?: number): void;
}

export interface Counter {
  readonly type: 'counter';
  readonly name: string;
  inc(value?: number): void;
  inc(labels: LabelValues, value?: number): void;
  labels(labels: LabelValues): BoundCounter;
  get(labels?: LabelValues): number;
  reset(): void;
}

export interface BoundGauge {
  set(value: number): void;
  inc(value?: number): void;
  dec(value?: number): void;
}

export interface Gauge {
  readonly type: 'gauge';
  readonly name: string;
  set(value: number): void;
  set(labels: LabelValues, value: number): void;
  inc(value?: number): void;
  inc(labels: LabelValues, value?: number): void;
  dec(value?: number): void;
  dec(labels: LabelValues, value?: number): void;
  labels(labels: LabelValues): BoundGauge;
  get(labels?: LabelValues): number;
  reset(): void;
}

export interface HistogramValue {
  /** Cumulative counts per upper bound, the last bound is +Infinity. */
  buckets: { le: number; count: number }[];
  sum: number;
  count: number;
}

export interface BoundHistogram {
  observe(value: number): void;
  /** Returns a function that records the elapsed seconds and returns them. */
  startTimer(): () => number;
}

export interface Histogram {
  readonly type: 'histogram';
  readonly name: string;
  readonly buckets: readonly number[];
  observe(value: number): void;
  observe(labels: LabelValues, value: number): void;
  labels(labels: LabelValues): BoundHistogram;
  /** Starts a timer; the returned function records elapsed seconds with the merged labels. */
  startTimer(labels?: LabelValues): (endLabels?: LabelValues) => number;
  get(labels?: LabelValues): HistogramValue;
  reset(): void;
}

export type Metric = Counter | Gauge | Histogram;

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSample {
  labels: Record<string, string>;
  /** Cumulative bucket counts; `le` is a string so `+Inf` survives JSON. */
  buckets: { le: string; count: number }[];
  sum: number;
  count: number;
}

export type MetricSnapshot =
  | { name: string; help: string; type: 'counter' | 'gauge'; samples: MetricSample[] }
  | { name: string; help: string; type: 'histogram'; samples: HistogramSample[] };

export interface MetricsSnapshot {
  /** Epoch milliseconds. */
  timestamp: number;
  metrics: MetricSnapshot[];
}

/** Emitted to subscribers for every recorded value (used by the OpenTelemetry bridge). */
export interface MetricEvent {
  type: MetricType;
  name: string;
  labels: Record<string, string>;
  /** Counter: the increment. Gauge: the new value. Histogram: the observation. */
  value: number;
}

export interface MetricsRegistryOptions {
  /** Prepended to every metric name, for example `myapp_`. */
  prefix?: string;
  /** Labels added to every exposed series, for example `{ service: 'api' }`. */
  defaultLabels?: Record<string, string>;
  /** Default cardinality limit per metric. Default 1000. */
  maxLabelSets?: number;
  /** Receives cardinality and collector warnings. */
  logger?: LoggerLike;
  clock?: Clock;
}

export interface MetricsRegistry {
  readonly prefix: string;
  readonly contentType: string;
  counter(options: MetricOptions): Counter;
  gauge(options: MetricOptions): Gauge;
  histogram(options: HistogramOptions): Histogram;
  /** Looks up a metric by its full (prefixed) name. */
  getMetric(name: string): Metric | undefined;
  list(): Metric[];
  remove(name: string): boolean;
  /** Runs collect callbacks. Failures are logged and do not abort collection. */
  collect(): Promise<void>;
  /** Prometheus text exposition format 0.0.4. */
  metrics(): Promise<string>;
  /** JSON snapshot of every series. */
  snapshot(): Promise<MetricsSnapshot>;
  /** Clears every series (unlabelled series return to zero). */
  reset(): void;
  subscribe(listener: (event: MetricEvent) => void): () => void;
  /** Help text and label names of a metric (full name). */
  describe(
    name: string,
  ): { help: string; labelNames: readonly string[]; type: MetricType } | undefined;
}

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

interface Series<V> {
  labels: Record<string, string>;
  value: V;
}

interface Internal {
  readonly type: MetricType;
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly bucketList?: readonly number[];
  readonly collectFn?: () => void | Promise<void>;
  seriesList(): Iterable<Series<number | HistogramSeries>>;
  clear(): void;
}

export function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export function formatSampleValue(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  if (Number.isNaN(value)) return 'NaN';
  return String(value);
}

function validateBuckets(buckets: readonly number[]): number[] {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw configError('buckets', 'must be a non-empty array of numbers');
  }
  const out: number[] = [];
  for (const b of buckets) {
    if (typeof b !== 'number' || !Number.isFinite(b))
      throw configError('buckets', 'must contain finite numbers');
    const last = out[out.length - 1];
    if (last !== undefined && b <= last)
      throw configError('buckets', 'must be strictly increasing');
    out.push(b);
  }
  return out;
}

function _sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function invalidValue(metric: string, problem: string): ObservabilityError {
  return new ObservabilityError(
    ObservabilityErrorCodes.invalidMetricValue,
    `Metric ${metric}: ${problem}`,
  );
}

/**
 * Creates a metrics registry. Metrics are cheap in-process aggregates; exposition renders the
 * Prometheus text format 0.0.4 and a JSON snapshot. No runtime dependencies.
 */
export function createMetricsRegistry(options: MetricsRegistryOptions = {}): MetricsRegistry {
  const prefix = options.prefix ?? '';
  if (prefix !== '' && !METRIC_NAME.test(prefix)) {
    throw configError('prefix', 'must match [a-zA-Z_:][a-zA-Z0-9_:]*');
  }
  const defaultLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.defaultLabels ?? {})) {
    if (!LABEL_NAME.test(k) || k.startsWith('__'))
      throw configError('defaultLabels', `invalid label name "${k}"`);
    if (typeof v !== 'string')
      throw configError('defaultLabels', `value of "${k}" must be a string`);
    defaultLabels[k] = v;
  }
  const defaultMax = options.maxLabelSets ?? DEFAULT_MAX_LABEL_SETS;
  if (!Number.isInteger(defaultMax) || defaultMax < 1) {
    throw configError('maxLabelSets', 'must be a positive integer');
  }
  const logger = options.logger;
  const clock = options.clock ?? { now: () => Date.now() };
  const metrics = new Map<string, { internal: Internal; api: Metric; signature: string }>();
  const listeners = new Set<(event: MetricEvent) => void>();
  const warned = new Set<string>();
  let droppedCounter: Counter | undefined;
  const droppedName = `${prefix}observability_metric_label_sets_dropped_total`;

  const emit = (event: MetricEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger?.warn({ err: error, metric: event.name }, 'metric subscriber failed');
      }
    }
  };

  const onDrop = (metric: string, limit: number): void => {
    if (!warned.has(metric)) {
      warned.add(metric);
      logger?.warn(
        { metric, maxLabelSets: limit },
        'metric label cardinality limit reached; new label sets are dropped',
      );
    }
    if (metric === droppedName) return;
    droppedCounter ??= registry.counter({
      name: 'observability_metric_label_sets_dropped_total',
      help: 'Samples dropped because a metric reached its label set limit.',
      labelNames: ['metric'],
    });
    droppedCounter.inc({ metric });
  };

  function prepare(opts: MetricOptions, type: MetricType) {
    if (!opts || typeof opts.name !== 'string' || !METRIC_NAME.test(opts.name)) {
      throw new ObservabilityError(
        ObservabilityErrorCodes.invalidMetricName,
        `Invalid metric name "${String(opts?.name)}": must match [a-zA-Z_:][a-zA-Z0-9_:]*`,
      );
    }
    if (typeof opts.help !== 'string' || opts.help.length === 0) {
      throw configError(`${opts.name}.help`, 'must be a non-empty string');
    }
    const labelNames = [...(opts.labelNames ?? [])];
    const seen = new Set<string>();
    for (const l of labelNames) {
      if (typeof l !== 'string' || !LABEL_NAME.test(l) || l.startsWith('__')) {
        throw new ObservabilityError(
          ObservabilityErrorCodes.invalidLabels,
          `Metric ${opts.name}: invalid label name "${l}"`,
        );
      }
      if (type === 'histogram' && l === 'le') {
        throw new ObservabilityError(
          ObservabilityErrorCodes.invalidLabels,
          `Metric ${opts.name}: "le" is reserved for histograms`,
        );
      }
      if (seen.has(l))
        throw new ObservabilityError(
          ObservabilityErrorCodes.invalidLabels,
          `Metric ${opts.name}: duplicate label "${l}"`,
        );
      if (Object.hasOwn(defaultLabels, l)) {
        throw new ObservabilityError(
          ObservabilityErrorCodes.invalidLabels,
          `Metric ${opts.name}: label "${l}" collides with a default label`,
        );
      }
      seen.add(l);
    }
    const maxLabelSets = opts.maxLabelSets ?? defaultMax;
    if (!Number.isInteger(maxLabelSets) || maxLabelSets < 1) {
      throw configError(`${opts.name}.maxLabelSets`, 'must be a positive integer');
    }
    if (opts.collect !== undefined && typeof opts.collect !== 'function') {
      throw configError(`${opts.name}.collect`, 'must be a function');
    }
    return { fullName: prefix + opts.name, labelNames, labelSet: seen, maxLabelSets };
  }

  function lookup<T extends Metric>(fullName: string, signature: string): T | undefined {
    const existing = metrics.get(fullName);
    if (!existing) return undefined;
    if (existing.signature !== signature) {
      throw new ObservabilityError(
        ObservabilityErrorCodes.metricConflict,
        `Metric ${fullName} is already registered with a different type, help, labels or buckets`,
      );
    }
    return existing.api as T;
  }

  /** Shared series bookkeeping: label validation, key building, cardinality limit. */
  function seriesStore<V>(
    fullName: string,
    labelNames: readonly string[],
    labelSet: ReadonlySet<string>,
    maxLabelSets: number,
    init: () => V,
  ) {
    const series = new Map<string, Series<V>>();
    const normalise = (labels: LabelValues | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      if (labels) {
        for (const key of Object.keys(labels)) {
          if (!labelSet.has(key)) {
            throw new ObservabilityError(
              ObservabilityErrorCodes.invalidLabels,
              `Metric ${fullName}: unknown label "${key}" (declared: ${labelNames.join(', ') || 'none'})`,
            );
          }
        }
      }
      for (const name of labelNames) {
        const v = labels?.[name];
        out[name] = v === undefined ? '' : String(v);
      }
      return out;
    };
    const keyOf = (labels: Record<string, string>): string => {
      if (labelNames.length === 0) return '';
      if (labelNames.length === 1) return labels[labelNames[0] as string] ?? '';
      return JSON.stringify(labelNames.map((n) => labels[n]));
    };
    const get = (labels: LabelValues | undefined): Series<V> | undefined => {
      const norm = normalise(labels);
      const key = keyOf(norm);
      let s = series.get(key);
      if (!s) {
        if (series.size >= maxLabelSets) {
          onDrop(fullName, maxLabelSets);
          return undefined;
        }
        s = { labels: norm, value: init() };
        series.set(key, s);
      }
      return s;
    };
    const peek = (labels: LabelValues | undefined): Series<V> | undefined =>
      series.get(keyOf(normalise(labels)));
    const clear = (): void => {
      series.clear();
      if (labelNames.length === 0) series.set('', { labels: {}, value: init() });
    };
    clear();
    return { series, get, peek, clear };
  }

  function makeScalar(type: 'counter' | 'gauge', opts: MetricOptions): Counter | Gauge {
    const { fullName, labelNames, labelSet, maxLabelSets } = prepare(opts, type);
    const signature = JSON.stringify([type, opts.help, labelNames]);
    const existing = lookup<Counter | Gauge>(fullName, signature);
    if (existing) return existing;
    const store = seriesStore<number>(fullName, labelNames, labelSet, maxLabelSets, () => 0);

    const add = (labels: LabelValues | undefined, delta: number): void => {
      if (typeof delta !== 'number' || Number.isNaN(delta))
        throw invalidValue(fullName, 'value must be a number');
      if (type === 'counter' && delta < 0)
        throw invalidValue(fullName, 'counters can only increase');
      const s = store.get(labels);
      if (!s) return;
      s.value += delta;
      if (listeners.size > 0) {
        emit(
          type === 'counter'
            ? { type, name: fullName, labels: s.labels, value: delta }
            : { type, name: fullName, labels: s.labels, value: s.value },
        );
      }
    };
    const set = (labels: LabelValues | undefined, value: number): void => {
      if (typeof value !== 'number') throw invalidValue(fullName, 'value must be a number');
      const s = store.get(labels);
      if (!s) return;
      s.value = value;
      if (listeners.size > 0) emit({ type, name: fullName, labels: s.labels, value });
    };
    const split = (
      a: LabelValues | number | undefined,
      b: number | undefined,
      dflt: number,
    ): [LabelValues | undefined, number] =>
      typeof a === 'object' ? [a, b ?? dflt] : [undefined, a ?? dflt];

    const internal: Internal = {
      type,
      name: fullName,
      help: opts.help,
      labelNames,
      ...(opts.collect ? { collectFn: opts.collect } : {}),
      seriesList: () => store.series.values(),
      clear: store.clear,
    };
    let api: Counter | Gauge;
    if (type === 'counter') {
      const counter: Counter = {
        type: 'counter',
        name: fullName,
        inc: (a?: LabelValues | number, b?: number) => {
          const [labels, v] = split(a, b, 1);
          add(labels, v);
        },
        labels: (labels) => ({ inc: (v = 1) => add(labels, v) }),
        get: (labels) => store.peek(labels)?.value ?? 0,
        reset: store.clear,
      };
      api = counter;
    } else {
      const gauge: Gauge = {
        type: 'gauge',
        name: fullName,
        set: (a: LabelValues | number, b?: number) => {
          if (typeof a === 'object') set(a, b as number);
          else set(undefined, a);
        },
        inc: (a?: LabelValues | number, b?: number) => {
          const [labels, v] = split(a, b, 1);
          add(labels, v);
        },
        dec: (a?: LabelValues | number, b?: number) => {
          const [labels, v] = split(a, b, 1);
          add(labels, -v);
        },
        labels: (labels) => ({
          set: (v) => set(labels, v),
          inc: (v = 1) => add(labels, v),
          dec: (v = 1) => add(labels, -v),
        }),
        get: (labels) => store.peek(labels)?.value ?? 0,
        reset: store.clear,
      };
      api = gauge;
    }
    metrics.set(fullName, { internal, api, signature });
    return api;
  }

  function makeHistogram(opts: HistogramOptions): Histogram {
    const { fullName, labelNames, labelSet, maxLabelSets } = prepare(opts, 'histogram');
    const buckets = validateBuckets(opts.buckets ?? DEFAULT_HTTP_DURATION_BUCKETS);
    const signature = JSON.stringify(['histogram', opts.help, labelNames, buckets]);
    const existing = lookup<Histogram>(fullName, signature);
    if (existing) return existing;
    const bounds = [...buckets, Number.POSITIVE_INFINITY];
    const store = seriesStore<HistogramSeries>(
      fullName,
      labelNames,
      labelSet,
      maxLabelSets,
      () => ({
        counts: new Array<number>(bounds.length).fill(0),
        sum: 0,
        count: 0,
      }),
    );
    const bucketIndex = (value: number): number => {
      let lo = 0;
      let hi = bounds.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (value <= (bounds[mid] as number)) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const observe = (labels: LabelValues | undefined, value: number): void => {
      if (typeof value !== 'number' || Number.isNaN(value))
        throw invalidValue(fullName, 'observation must be a number');
      const s = store.get(labels);
      if (!s) return;
      const i = bucketIndex(value);
      s.value.counts[i] = (s.value.counts[i] ?? 0) + 1;
      s.value.sum += value;
      s.value.count += 1;
      if (listeners.size > 0) emit({ type: 'histogram', name: fullName, labels: s.labels, value });
    };
    const timer = (labels: LabelValues | undefined) => {
      const start = process.hrtime.bigint();
      return (endLabels?: LabelValues): number => {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        observe(endLabels ? { ...labels, ...endLabels } : labels, seconds);
        return seconds;
      };
    };
    const internal: Internal = {
      type: 'histogram',
      name: fullName,
      help: opts.help,
      labelNames,
      bucketList: buckets,
      ...(opts.collect ? { collectFn: opts.collect } : {}),
      seriesList: () => store.series.values(),
      clear: store.clear,
    };
    const api: Histogram = {
      type: 'histogram',
      name: fullName,
      buckets,
      observe: (a: LabelValues | number, b?: number) => {
        if (typeof a === 'object') observe(a, b as number);
        else observe(undefined, a);
      },
      labels: (labels) => ({ observe: (v) => observe(labels, v), startTimer: () => timer(labels) }),
      startTimer: (labels) => timer(labels),
      get(labels) {
        const s = store.peek(labels);
        let cumulative = 0;
        return {
          buckets: bounds.map((le, i) => {
            cumulative += s?.value.counts[i] ?? 0;
            return { le, count: cumulative };
          }),
          sum: s?.value.sum ?? 0,
          count: s?.value.count ?? 0,
        };
      },
      reset: store.clear,
    };
    metrics.set(fullName, { internal, api, signature });
    return api;
  }

  const renderLabels = (labels: Record<string, string>, extra?: string): string => {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(labels)) {
      if (v === '') continue;
      parts.push(`${k}="${escapeLabelValue(v)}"`);
    }
    for (const [k, v] of Object.entries(defaultLabels)) parts.push(`${k}="${escapeLabelValue(v)}"`);
    if (extra) parts.push(extra);
    return parts.length === 0 ? '' : `{${parts.join(',')}}`;
  };

  const registry: MetricsRegistry = {
    prefix,
    contentType: PROMETHEUS_CONTENT_TYPE,
    counter: (opts) => makeScalar('counter', opts) as Counter,
    gauge: (opts) => makeScalar('gauge', opts) as Gauge,
    histogram: makeHistogram,
    getMetric: (name) => metrics.get(name)?.api,
    list: () => [...metrics.values()].map((m) => m.api),
    remove: (name) => metrics.delete(name),
    describe(name) {
      const m = metrics.get(name);
      return m
        ? { help: m.internal.help, labelNames: m.internal.labelNames, type: m.internal.type }
        : undefined;
    },
    async collect() {
      const collectors = [...metrics.values()].flatMap((m) =>
        m.internal.collectFn ? [m.internal] : [],
      );
      const results = await Promise.allSettled(collectors.map(async (m) => m.collectFn?.()));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          logger?.warn(
            { err: r.reason, metric: collectors[i]?.name },
            'metric collect callback failed',
          );
        }
      });
    },
    async metrics() {
      await registry.collect();
      let out = '';
      for (const { internal } of metrics.values()) {
        out += `# HELP ${internal.name} ${escapeHelp(internal.help)}\n# TYPE ${internal.name} ${internal.type}\n`;
        if (internal.type === 'histogram') {
          const bounds = [...(internal.bucketList ?? []), Number.POSITIVE_INFINITY];
          for (const s of internal.seriesList() as Iterable<Series<HistogramSeries>>) {
            let cumulative = 0;
            bounds.forEach((le, i) => {
              cumulative += s.value.counts[i] ?? 0;
              out += `${internal.name}_bucket${renderLabels(s.labels, `le="${formatSampleValue(le)}"`)} ${cumulative}\n`;
            });
            const labels = renderLabels(s.labels);
            out += `${internal.name}_sum${labels} ${formatSampleValue(s.value.sum)}\n`;
            out += `${internal.name}_count${labels} ${s.value.count}\n`;
          }
        } else {
          for (const s of internal.seriesList() as Iterable<Series<number>>) {
            out += `${internal.name}${renderLabels(s.labels)} ${formatSampleValue(s.value)}\n`;
          }
        }
      }
      return out;
    },
    async snapshot() {
      await registry.collect();
      const withDefaults = (labels: Record<string, string>): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(labels)) if (v !== '') out[k] = v;
        return Object.assign(out, defaultLabels);
      };
      const out: MetricSnapshot[] = [];
      for (const { internal } of metrics.values()) {
        if (internal.type === 'histogram') {
          const bounds = [...(internal.bucketList ?? []), Number.POSITIVE_INFINITY];
          const samples: HistogramSample[] = [];
          for (const s of internal.seriesList() as Iterable<Series<HistogramSeries>>) {
            let cumulative = 0;
            samples.push({
              labels: withDefaults(s.labels),
              buckets: bounds.map((le, i) => {
                cumulative += s.value.counts[i] ?? 0;
                return { le: formatSampleValue(le), count: cumulative };
              }),
              sum: s.value.sum,
              count: s.value.count,
            });
          }
          out.push({ name: internal.name, help: internal.help, type: 'histogram', samples });
        } else {
          const samples: MetricSample[] = [];
          for (const s of internal.seriesList() as Iterable<Series<number>>) {
            samples.push({ labels: withDefaults(s.labels), value: s.value });
          }
          out.push({
            name: internal.name,
            help: internal.help,
            type: internal.type as 'counter' | 'gauge',
            samples,
          });
        }
      }
      return { timestamp: clock.now(), metrics: out };
    },
    reset() {
      for (const { internal } of metrics.values()) internal.clear();
      warned.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return registry;
}
