import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { invalidOption, TestingError, TestingErrorCode } from './errors.js';

export type CoverageMetric = 'lines' | 'statements' | 'functions' | 'branches';
export type CoverageThresholds = Partial<Record<CoverageMetric, number>>;

export const DEFAULT_COVERAGE_THRESHOLDS: Required<CoverageThresholds> = {
  lines: 80,
  statements: 80,
  functions: 80,
  branches: 75,
};

export const DEFAULT_COVERAGE_INCLUDE: readonly string[] = [
  'src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
];

export const DEFAULT_COVERAGE_EXCLUDE: readonly string[] = [
  '**/*.d.ts',
  '**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test/**',
  '**/tests/**',
  '**/fixtures/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.config.{ts,mts,cts,js,mjs,cjs}',
];

export const DEFAULT_COVERAGE_REPORTERS: readonly string[] = ['text', 'lcov', 'json-summary'];

export interface AspecVitestConfigOptions {
  /** Test file globs. Default: `test/**` and `src/**` test files. */
  include?: readonly string[];
  exclude?: readonly string[];
  /** Setup files (for example "test/setup.ts"). */
  setupFiles?: readonly string[];
  /** Vitest environment (default "node"). */
  environment?: string;
  testTimeout?: number;
  coverage?: {
    /** Collect coverage without `--coverage` (default false). */
    enabled?: boolean;
    include?: readonly string[];
    /** Added to the default exclude list. */
    exclude?: readonly string[];
    /** Replaces the default exclude list. */
    replaceExclude?: boolean;
    reporters?: readonly string[];
    reportsDirectory?: string;
    /** Thresholds in percent; `false` disables them. Defaults: lines 80, statements 80, functions 80, branches 75. */
    thresholds?: CoverageThresholds | false;
    /** Write reports even when tests fail (default true, so CI gates can read them). */
    reportOnFailure?: boolean;
  };
  /** Extra `test` options merged last (shallow). */
  test?: Record<string, unknown>;
}

/** Vitest configuration object (structurally compatible with `defineConfig` from vitest/config). */
export interface AspecVitestConfig {
  test: {
    include: string[];
    exclude?: string[];
    setupFiles: string[];
    environment: string;
    testTimeout?: number;
    coverage: {
      provider: 'v8';
      enabled: boolean;
      include: string[];
      exclude: string[];
      reporter: string[];
      reportsDirectory: string;
      reportOnFailure: boolean;
      thresholds?: CoverageThresholds;
    };
    [key: string]: unknown;
  };
}

function checkThresholds(t: CoverageThresholds, option: string): void {
  for (const [k, v] of Object.entries(t)) {
    if (!['lines', 'statements', 'functions', 'branches'].includes(k))
      throw invalidOption(option, `unknown metric "${k}"`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)
      throw invalidOption(`${option}.${k}`, 'must be between 0 and 100');
  }
}

/**
 * Returns a Vitest config with V8 coverage, sensible include and exclude patterns, the text,
 * lcov and json-summary reporters, and thresholds. Use it as the default export of
 * vitest.config.ts, optionally wrapped in defineConfig or mergeConfig.
 */
export function defineAspecVitestConfig(options: AspecVitestConfigOptions = {}): AspecVitestConfig {
  const cov = options.coverage ?? {};
  const thresholds =
    cov.thresholds === false ? undefined : { ...DEFAULT_COVERAGE_THRESHOLDS, ...cov.thresholds };
  if (thresholds) checkThresholds(thresholds, 'coverage.thresholds');
  const exclude = cov.replaceExclude
    ? [...(cov.exclude ?? [])]
    : [...DEFAULT_COVERAGE_EXCLUDE, ...(cov.exclude ?? [])];
  const config: AspecVitestConfig = {
    test: {
      include: [
        ...(options.include ?? [
          'test/**/*.{test,spec}.?(c|m)[jt]s?(x)',
          'src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
        ]),
      ],
      setupFiles: [...(options.setupFiles ?? [])],
      environment: options.environment ?? 'node',
      coverage: {
        provider: 'v8',
        enabled: cov.enabled ?? false,
        include: [...(cov.include ?? DEFAULT_COVERAGE_INCLUDE)],
        exclude,
        reporter: [...(cov.reporters ?? DEFAULT_COVERAGE_REPORTERS)],
        reportsDirectory: cov.reportsDirectory ?? 'coverage',
        reportOnFailure: cov.reportOnFailure ?? true,
      },
    },
  };
  if (thresholds) config.test.coverage.thresholds = thresholds;
  if (options.exclude) config.test.exclude = [...options.exclude];
  if (options.testTimeout !== undefined) config.test.testTimeout = options.testTimeout;
  if (options.test) Object.assign(config.test, options.test);
  return config;
}

export interface CoverageMetricSummary {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export type CoverageEntry = Record<CoverageMetric, CoverageMetricSummary>;

export interface CoverageSummary {
  total: CoverageEntry;
  /** Per-file entries keyed by absolute path. */
  files: Record<string, CoverageEntry>;
  /** The file that was read. */
  file: string;
}

export interface CoverageSummaryOptions {
  /** Path to coverage-summary.json. Default "coverage/coverage-summary.json" relative to cwd. */
  file?: string;
  cwd?: string;
}

function isEntry(value: unknown): value is CoverageEntry {
  if (value === null || typeof value !== 'object') return false;
  return (['lines', 'statements', 'functions', 'branches'] as const).every((m) => {
    const s = (value as Record<string, unknown>)[m];
    return (
      s !== null && typeof s === 'object' && typeof (s as Record<string, unknown>).pct === 'number'
    );
  });
}

/** Reads the json-summary reporter output (coverage-summary.json). */
export async function coverageSummary(
  options: CoverageSummaryOptions = {},
): Promise<CoverageSummary> {
  const file = resolve(
    options.cwd ?? process.cwd(),
    options.file ?? 'coverage/coverage-summary.json',
  );
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new TestingError(
      TestingErrorCode.COVERAGE_SUMMARY_MISSING,
      `Coverage summary not found at ${file}. Run tests with --coverage and the json-summary reporter.`,
      { cause: err },
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new TestingError(
      TestingErrorCode.COVERAGE_SUMMARY_MISSING,
      `Coverage summary at ${file} is not valid JSON`,
      { cause: err },
    );
  }
  const record = data as Record<string, unknown>;
  if (!isEntry(record.total)) {
    throw new TestingError(
      TestingErrorCode.COVERAGE_SUMMARY_MISSING,
      `Coverage summary at ${file} has no "total" entry`,
    );
  }
  const files: Record<string, CoverageEntry> = {};
  for (const [k, v] of Object.entries(record)) if (k !== 'total' && isEntry(v)) files[k] = v;
  return { total: record.total, files, file };
}

export interface CoverageCheckResult {
  ok: boolean;
  failures: { metric: CoverageMetric; actual: number; threshold: number }[];
}

/** Compares summary totals against thresholds (percent). */
export function checkCoverage(
  summary: CoverageSummary,
  thresholds: CoverageThresholds = DEFAULT_COVERAGE_THRESHOLDS,
): CoverageCheckResult {
  checkThresholds(thresholds, 'thresholds');
  const failures: CoverageCheckResult['failures'] = [];
  for (const [metric, threshold] of Object.entries(thresholds) as [CoverageMetric, number][]) {
    const actual = summary.total[metric].pct;
    if (actual < threshold) failures.push({ metric, actual, threshold });
  }
  return { ok: failures.length === 0, failures };
}

/** Throws TESTING_COVERAGE_BELOW_THRESHOLD when any total is below its threshold. */
export async function assertCoverage(
  thresholds: CoverageThresholds = DEFAULT_COVERAGE_THRESHOLDS,
  options: CoverageSummaryOptions = {},
): Promise<CoverageSummary> {
  const summary = await coverageSummary(options);
  const result = checkCoverage(summary, thresholds);
  if (!result.ok) {
    throw new TestingError(
      TestingErrorCode.COVERAGE_BELOW_THRESHOLD,
      `Coverage below threshold: ${result.failures.map((f) => `${f.metric} ${f.actual}% < ${f.threshold}%`).join(', ')}`,
      { details: result.failures },
    );
  }
  return summary;
}
