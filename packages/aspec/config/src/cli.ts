import { pathToFileURL } from 'node:url';
import type { ConfigShape } from './define.js';
import { defineConfig } from './define.js';
import { generateEnvExample, generateMarkdownDocs, toJSONSchema } from './docs.js';
import { ConfigError, isConfigError } from './errors.js';

function usage(): string {
  return `aspec-config <command> <config-module>

Commands:
  check     Load and validate the config module (executes the module)
  docs      Print Markdown documentation for the shape export
  example   Print a .env.example for the shape export

The config module must export either:
  - default: a config object from defineConfig(...), or
  - shape: a defineConfig shape, or
  - config + shape

Warning: loading a user config module executes that module's code.
`;
}

async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  const url = specifier.startsWith('file:') ? specifier : pathToFileURL(specifier).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError('CONFIG_LOAD_ERROR', `could not import ${specifier}`, [], { cause: err });
  }
}

function resolveShape(mod: Record<string, unknown>): ConfigShape {
  if (mod.shape && typeof mod.shape === 'object') return mod.shape as ConfigShape;
  if (mod.default && typeof mod.default === 'object' && 'shape' in (mod.default as object)) {
    return (mod.default as { shape: ConfigShape }).shape;
  }
  throw new ConfigError(
    'CONFIG_LOAD_ERROR',
    'config module must export `shape` (the defineConfig input object)',
  );
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, modulePath] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return command ? 0 : 1;
  }
  if (!modulePath) {
    process.stderr.write(usage());
    return 1;
  }
  try {
    const mod = await loadModule(modulePath);
    const shape = resolveShape(mod);
    switch (command) {
      case 'check': {
        defineConfig(shape);
        process.stdout.write('OK\n');
        return 0;
      }
      case 'docs': {
        process.stdout.write(generateMarkdownDocs(shape));
        return 0;
      }
      case 'example': {
        process.stdout.write(generateEnvExample(shape));
        return 0;
      }
      case 'schema': {
        process.stdout.write(`${JSON.stringify(toJSONSchema(shape), null, 2)}\n`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n${usage()}`);
        return 1;
    }
  } catch (err) {
    if (isConfigError(err) && err.code === 'CONFIG_INVALID') {
      process.stderr.write(`${err.toReport()}\n`);
      process.stderr.write(`${JSON.stringify(err.toJSON())}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv);
}
