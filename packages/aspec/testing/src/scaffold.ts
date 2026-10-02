import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { invalidOption, TestingError, TestingErrorCode } from './errors.js';

export type ModuleSystem = 'esm' | 'commonjs';
export type Language = 'typescript' | 'javascript';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type GenerateKind = 'unit' | 'integration' | 'api';

export interface ProjectDetection {
  root: string;
  language: Language;
  moduleSystem: ModuleSystem;
  packageManager: PackageManager;
  hasVitestConfig: boolean;
  hasPackageJson: boolean;
  packageName: string | undefined;
}

export interface ScaffoldFile {
  path: string;
  content: string;
  action: 'create' | 'skip' | 'conflict';
  reason?: string;
}

export interface ScaffoldResult {
  detection: ProjectDetection;
  files: ScaffoldFile[];
  dryRun: boolean;
  ok: boolean;
  conflicts: string[];
}

export interface InitOptions {
  cwd?: string;
  dryRun?: boolean;
  /** Force language detection override. */
  language?: Language;
  moduleSystem?: ModuleSystem;
  /** Import specifier for @aspec/testing in generated files. Default "@aspec/testing". */
  importSpecifier?: string;
}

export interface GenerateOptions {
  cwd?: string;
  dryRun?: boolean;
  kind: GenerateKind;
  name: string;
  language?: Language;
  moduleSystem?: ModuleSystem;
  importSpecifier?: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(root, 'yarn.lock'))) return 'yarn';
  if ((await exists(join(root, 'bun.lockb'))) || (await exists(join(root, 'bun.lock'))))
    return 'bun';
  return 'npm';
}

/** Detects TypeScript/JavaScript, ESM/CJS and the package manager for a project root. */
export async function detectProject(cwd = process.cwd()): Promise<ProjectDetection> {
  const root = resolve(cwd);
  let hasPackageJson = false;
  let packageName: string | undefined;
  let moduleSystem: ModuleSystem = 'esm';
  let language: Language = 'javascript';
  const pkgPath = join(root, 'package.json');
  if (await exists(pkgPath)) {
    hasPackageJson = true;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        name?: string;
        type?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      packageName = pkg.name;
      // Node defaults to CommonJS when "type" is absent.
      moduleSystem = pkg.type === 'module' ? 'esm' : 'commonjs';
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript || deps['ts-node'] || deps.tsx) language = 'typescript';
    } catch {
      // Ignore malformed package.json; keep defaults.
    }
  }
  if (await exists(join(root, 'tsconfig.json'))) language = 'typescript';
  const hasVitestConfig =
    (await exists(join(root, 'vitest.config.ts'))) ||
    (await exists(join(root, 'vitest.config.mts'))) ||
    (await exists(join(root, 'vitest.config.js'))) ||
    (await exists(join(root, 'vitest.config.mjs'))) ||
    (await exists(join(root, 'vite.config.ts'))) ||
    (await exists(join(root, 'vite.config.js')));
  return {
    root,
    language,
    moduleSystem,
    packageManager: await detectPackageManager(root),
    hasVitestConfig,
    hasPackageJson,
    packageName,
  };
}

function extFor(
  language: Language,
  moduleSystem: ModuleSystem,
): { source: string; config: string } {
  if (language === 'typescript') return { source: 'ts', config: 'ts' };
  return {
    source: moduleSystem === 'commonjs' ? 'cjs' : 'js',
    config: moduleSystem === 'commonjs' ? 'cjs' : 'mjs',
  };
}

function importLine(
  specifier: string,
  names: string,
  moduleSystem: ModuleSystem,
  language: Language,
): string {
  if (moduleSystem === 'commonjs' && language === 'javascript') {
    return `const { ${names} } = require(${JSON.stringify(specifier)});`;
  }
  return `import { ${names} } from ${JSON.stringify(specifier)};`;
}

function exportDefault(expr: string, moduleSystem: ModuleSystem, language: Language): string {
  if (moduleSystem === 'commonjs' && language === 'javascript')
    return `module.exports = ${expr};\n`;
  return `export default ${expr};\n`;
}

function vitestConfigContent(
  importSpecifier: string,
  language: Language,
  moduleSystem: ModuleSystem,
  setupFile: string,
): string {
  const imp = importLine(importSpecifier, 'defineAspecVitestConfig', moduleSystem, language);
  const setup = setupFile.replace(/\\/g, '/');
  const body = `defineAspecVitestConfig({\n  setupFiles: [${JSON.stringify(setup)}],\n})`;
  return `${imp}\n\n${exportDefault(body, moduleSystem, language)}`;
}

function setupContent(
  importSpecifier: string,
  language: Language,
  moduleSystem: ModuleSystem,
): string {
  const imp = importLine(
    importSpecifier,
    'cleanupAll, resetSequences, setSeed',
    moduleSystem,
    language,
  );
  const afterEach =
    moduleSystem === 'commonjs' && language === 'javascript'
      ? `const { afterEach } = require('vitest');\n`
      : `import { afterEach } from 'vitest';\n`;
  return `${afterEach}${imp}\n\nsetSeed(process.env.ASPEC_TEST_SEED ?? 'aspec-testing');\n\nafterEach(async () => {\n  resetSequences();\n  await cleanupAll();\n});\n`;
}

function exampleUnitContent(
  importSpecifier: string,
  language: Language,
  moduleSystem: ModuleSystem,
): string {
  const vitest =
    moduleSystem === 'commonjs' && language === 'javascript'
      ? `const { describe, expect, it } = require('vitest');\n`
      : `import { describe, expect, it } from 'vitest';\n`;
  const imp = importLine(importSpecifier, 'createRandom, defineFactory', moduleSystem, language);
  return `${vitest}${imp}\n\ndescribe('example unit', () => {\n  it('builds deterministic factory data', () => {\n    const users = defineFactory((ctx) => ({\n      id: ctx.random.uuid(),\n      email: ctx.random.email(),\n    }), { name: 'user' });\n    const a = users.build();\n    const b = createRandom('check').email();\n    expect(a.email).toMatch(/@example\\.test$/);\n    expect(typeof b).toBe('string');\n  });\n});\n`;
}

function exampleIntegrationContent(
  importSpecifier: string,
  language: Language,
  moduleSystem: ModuleSystem,
): string {
  const vitest =
    moduleSystem === 'commonjs' && language === 'javascript'
      ? `const { describe, expect, it } = require('vitest');\n`
      : `import { describe, expect, it } from 'vitest';\n`;
  const imp = importLine(
    importSpecifier,
    'createSqliteClient, migrate, withTransactionRollback',
    moduleSystem,
    language,
  );
  return `${vitest}${imp}\n\nconst migrations = [\n  {\n    id: '001_items',\n    sqlite: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);',\n    postgres: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);',\n  },\n];\n\ndescribe('example integration', () => {\n  it('isolates writes with a rollback fixture', async () => {\n    const db = createSqliteClient();\n    try {\n      await migrate(db, migrations);\n      await withTransactionRollback(db, async (tx) => {\n        await tx.query('INSERT INTO items (id, name) VALUES ($1, $2)', ['1', 'alpha']);\n        const rows = await tx.query('SELECT name FROM items');\n        expect(rows.rowCount).toBe(1);\n      });\n      const after = await db.query('SELECT name FROM items');\n      expect(after.rowCount).toBe(0);\n    } finally {\n      db.close();\n    }\n  });\n});\n`;
}

function exampleApiContent(
  importSpecifier: string,
  language: Language,
  moduleSystem: ModuleSystem,
): string {
  const vitest =
    moduleSystem === 'commonjs' && language === 'javascript'
      ? `const { describe, expect, it } = require('vitest');\n`
      : `import { describe, expect, it } from 'vitest';\n`;
  const imp = importLine(importSpecifier, 'createTestClient', moduleSystem, language);
  return `${vitest}${imp}\n\ndescribe('example api', () => {\n  it('exercises a Fetch handler', async () => {\n    const handler = (req) => {\n      const url = new URL(req.url);\n      return Response.json({ path: url.pathname, method: req.method });\n    };\n    const client = createTestClient(handler);\n    await client.get('/health').expect(200).expectJson({ path: '/health', method: 'GET' });\n  });\n});\n`;
}

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

function assertName(name: string): string {
  if (!NAME_RE.test(name) && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(toKebab(name))) {
    throw new TestingError(
      TestingErrorCode.SCAFFOLD_INVALID_NAME,
      `Invalid name "${name}": use letters, digits, _ or - (max 64)`,
    );
  }
  if (!NAME_RE.test(name)) {
    const kebab = toKebab(name);
    if (!NAME_RE.test(kebab)) {
      throw new TestingError(
        TestingErrorCode.SCAFFOLD_INVALID_NAME,
        `Invalid name "${name}": use letters, digits, _ or - (max 64)`,
      );
    }
    return kebab;
  }
  return name;
}

async function planFile(
  root: string,
  relativePath: string,
  content: string,
  dryRun: boolean,
): Promise<ScaffoldFile> {
  const abs = join(root, relativePath);
  if (await exists(abs)) {
    const existing = await readFile(abs, 'utf8');
    if (existing === content) {
      return { path: relativePath, content, action: 'skip', reason: 'already up to date' };
    }
    return {
      path: relativePath,
      content,
      action: 'conflict',
      reason: 'file exists with different content',
    };
  }
  if (!dryRun) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return { path: relativePath, content, action: 'create' };
}

/** Scaffolds Vitest config, setup and example unit/integration tests. Never overwrites. */
export async function scaffoldInit(options: InitOptions = {}): Promise<ScaffoldResult> {
  const detection = await detectProject(options.cwd);
  const language = options.language ?? detection.language;
  const moduleSystem = options.moduleSystem ?? detection.moduleSystem;
  const importSpecifier = options.importSpecifier ?? '@aspec/testing';
  const dryRun = options.dryRun ?? false;
  const { source, config } = extFor(language, moduleSystem);
  const setupRel = `test/setup.${source === 'cjs' ? 'cjs' : source === 'ts' ? 'ts' : 'js'}`;
  const planned: { rel: string; content: string }[] = [
    {
      rel: `vitest.config.${config}`,
      content: vitestConfigContent(importSpecifier, language, moduleSystem, setupRel),
    },
    { rel: setupRel, content: setupContent(importSpecifier, language, moduleSystem) },
    {
      rel: `test/example.unit.test.${source === 'cjs' ? 'cjs' : source === 'ts' ? 'ts' : 'js'}`,
      content: exampleUnitContent(importSpecifier, language, moduleSystem),
    },
    {
      rel: `test/example.integration.test.${source === 'cjs' ? 'cjs' : source === 'ts' ? 'ts' : 'js'}`,
      content: exampleIntegrationContent(importSpecifier, language, moduleSystem),
    },
  ];
  const files: ScaffoldFile[] = [];
  for (const p of planned) files.push(await planFile(detection.root, p.rel, p.content, dryRun));
  const conflicts = files.filter((f) => f.action === 'conflict').map((f) => f.path);
  if (conflicts.length > 0 && !dryRun) {
    throw new TestingError(
      TestingErrorCode.SCAFFOLD_CONFLICT,
      `Scaffold refused to overwrite: ${conflicts.join(', ')}. Remove them or re-run with --dry-run.`,
      { details: { conflicts } },
    );
  }
  return { detection, files, dryRun, ok: conflicts.length === 0, conflicts };
}

/** Generates a single unit, integration or API test file. Never overwrites. */
export async function scaffoldGenerate(options: GenerateOptions): Promise<ScaffoldResult> {
  const name = assertName(options.name);
  if (options.kind !== 'unit' && options.kind !== 'integration' && options.kind !== 'api') {
    throw invalidOption('kind', 'use unit, integration or api');
  }
  const detection = await detectProject(options.cwd);
  const language = options.language ?? detection.language;
  const moduleSystem = options.moduleSystem ?? detection.moduleSystem;
  const importSpecifier = options.importSpecifier ?? '@aspec/testing';
  const dryRun = options.dryRun ?? false;
  const { source } = extFor(language, moduleSystem);
  const ext = source === 'cjs' ? 'cjs' : source === 'ts' ? 'ts' : 'js';
  const content =
    options.kind === 'unit'
      ? exampleUnitContent(importSpecifier, language, moduleSystem).replace('example unit', name)
      : options.kind === 'integration'
        ? exampleIntegrationContent(importSpecifier, language, moduleSystem).replace(
            'example integration',
            name,
          )
        : exampleApiContent(importSpecifier, language, moduleSystem).replace('example api', name);
  const rel = `test/${toKebab(name)}.${options.kind}.test.${ext}`;
  const file = await planFile(detection.root, rel, content, dryRun);
  const conflicts = file.action === 'conflict' ? [file.path] : [];
  if (conflicts.length > 0 && !dryRun) {
    throw new TestingError(
      TestingErrorCode.SCAFFOLD_CONFLICT,
      `Scaffold refused to overwrite: ${conflicts.join(', ')}`,
      { details: { conflicts } },
    );
  }
  return { detection, files: [file], dryRun, ok: conflicts.length === 0, conflicts };
}

export interface CliJsonResult {
  ok: boolean;
  command: string;
  dryRun: boolean;
  conflicts: string[];
  files: { path: string; action: string; reason?: string }[];
  detection: ProjectDetection;
  error?: { code: string; message: string };
}

function toJson(result: ScaffoldResult, command: string): CliJsonResult {
  return {
    ok: result.ok,
    command,
    dryRun: result.dryRun,
    conflicts: result.conflicts,
    files: result.files.map((f) => {
      const row: { path: string; action: string; reason?: string } = {
        path: f.path,
        action: f.action,
      };
      if (f.reason !== undefined) row.reason = f.reason;
      return row;
    }),
    detection: result.detection,
  };
}

function printHuman(result: ScaffoldResult): void {
  for (const f of result.files) {
    const tag = f.action.toUpperCase();
    const extra = f.reason ? ` (${f.reason})` : '';
    console.log(`[${tag}] ${f.path}${extra}`);
  }
  if (result.conflicts.length > 0) {
    console.error(`Conflicts: ${result.conflicts.join(', ')}`);
  }
}

/** CLI entry used by the `aspec-testing` bin. */
export async function runScaffoldCli(
  argv: string[],
  options: { cwd?: string; stdout?: (s: string) => void; stderr?: (s: string) => void } = {},
): Promise<number> {
  const args = [...argv];
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const filtered = args.filter((a) => a !== '--dry-run' && a !== '--json');
  const command = filtered[0];
  const cwd = options.cwd ?? process.cwd();
  try {
    if (command === 'init') {
      const result = await scaffoldInit({ cwd, dryRun });
      if (json) console.log(JSON.stringify(toJson(result, 'init'), null, 2));
      else printHuman(result);
      return result.ok ? 0 : 1;
    }
    if (command === 'generate') {
      const kind = filtered[1] as GenerateKind | undefined;
      const name = filtered[2];
      if (!kind || !name) {
        throw invalidOption('args', 'usage: aspec-testing generate unit|integration|api <name>');
      }
      const result = await scaffoldGenerate({ cwd, dryRun, kind, name });
      if (json) console.log(JSON.stringify(toJson(result, 'generate'), null, 2));
      else printHuman(result);
      return result.ok ? 0 : 1;
    }
    if (command === 'detect') {
      const detection = await detectProject(cwd);
      console.log(JSON.stringify(detection, null, 2));
      return 0;
    }
    console.error(
      'Usage:\n  aspec-testing init [--dry-run] [--json]\n  aspec-testing generate unit|integration|api <name> [--dry-run] [--json]\n  aspec-testing detect',
    );
    return command ? 1 : 0;
  } catch (err) {
    if (json) {
      const code = err instanceof TestingError ? err.code : 'TESTING_INVALID_OPTION';
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify(
          {
            ok: false,
            command: command ?? '',
            dryRun,
            conflicts: [],
            files: [],
            detection: await detectProject(cwd),
            error: { code, message },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }
}
