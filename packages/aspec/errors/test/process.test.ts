import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installProcessHandlers, type ProcessLike } from '../src/index.js';
import { memoryLogger } from './helpers/http.js';

function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: (number | undefined)[] = [];
  const proc = Object.assign(emitter, {
    exit(code?: number) {
      exits.push(code);
    },
  }) as unknown as ProcessLike & EventEmitter;
  return { proc, exits };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('installProcessHandlers (mocked process)', () => {
  it('logs uncaught exceptions, runs the shutdown hook and exits', async () => {
    const { proc, exits } = fakeProcess();
    const { logger, entries } = memoryLogger();
    const calls: string[] = [];
    const uninstall = installProcessHandlers({
      logger,
      exitCode: 2,
      process: proc,
      onFatal: async (_err, event) => {
        calls.push(event);
      },
    });
    proc.emit('uncaughtException', new Error('boom token=abc123'));
    await tick();
    expect(calls).toEqual(['uncaughtException']);
    expect(exits).toEqual([2]);
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.obj).toMatchObject({ event: 'uncaughtException', fatal: true });
    expect(JSON.stringify(entries[0])).not.toContain('abc123');
    uninstall();
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });

  it('treats unhandled rejections as fatal by default and runs the hook once', async () => {
    const { proc, exits } = fakeProcess();
    let hookRuns = 0;
    installProcessHandlers({
      process: proc,
      logger: memoryLogger().logger,
      onFatal: async () => {
        hookRuns++;
        await tick(10);
      },
    });
    proc.emit('unhandledRejection', new Error('first'));
    proc.emit('uncaughtException', new Error('second'));
    await tick(30);
    expect(hookRuns).toBe(1);
    expect(exits).toEqual([1]);
  });

  it('only logs unhandled rejections in log mode', async () => {
    const { proc, exits } = fakeProcess();
    const { logger, entries } = memoryLogger();
    installProcessHandlers({ process: proc, logger, unhandledRejection: 'log' });
    proc.emit('unhandledRejection', 'plain reason');
    await tick();
    expect(exits).toEqual([]);
    expect(entries[0]?.obj).toMatchObject({ event: 'unhandledRejection', fatal: false });
  });

  it('exits after the timeout when the hook hangs, and survives hook failures', async () => {
    const hanging = fakeProcess();
    installProcessHandlers({
      process: hanging.proc,
      logger: memoryLogger().logger,
      timeoutMs: 20,
      onFatal: () => new Promise(() => {}),
    });
    hanging.proc.emit('uncaughtException', new Error('x'));
    await tick(5);
    expect(hanging.exits).toEqual([]);
    await tick(40);
    expect(hanging.exits).toEqual([1]);

    const failing = fakeProcess();
    const { logger, entries } = memoryLogger();
    installProcessHandlers({
      process: failing.proc,
      logger,
      onFatal: async () => {
        throw new Error('hook failed');
      },
    });
    failing.proc.emit('uncaughtException', new Error('x'));
    await tick();
    expect(failing.exits).toEqual([1]);
    expect(entries.map((e) => (e.obj.err as { message: string }).message)).toContain('hook failed');
  });

  it('validates options', () => {
    expect(() => installProcessHandlers({ exitCode: 300, process: fakeProcess().proc })).toThrow(
      TypeError,
    );
    expect(() => installProcessHandlers({ timeoutMs: -1, process: fakeProcess().proc })).toThrow(
      TypeError,
    );
  });
});

function runChild(mode: string): Promise<{ code: number | null; stdout: string; ms: number }> {
  const fixture = fileURLToPath(new URL('./fixtures/fatal-child.ts', import.meta.url));
  const register = new URL('./fixtures/register-ts.mjs', import.meta.url).href;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', register, fixture, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 3) console.error(stderr);
      resolve({ code, stdout, ms: Date.now() - started });
    });
  });
}

// Runs the TypeScript sources through Node's built-in type stripping (Node 23.6 and newer).
const supportsTypeStripping = Number(process.versions.node.split('.')[0]) >= 23;

describe.skipIf(!supportsTypeStripping)('installProcessHandlers (child process)', () => {
  it('handles a real uncaught exception with graceful shutdown and exit code', async () => {
    const { code, stdout } = await runChild('exception');
    expect(code).toBe(3);
    expect(stdout).toContain('SHUTDOWN_HOOK_RAN');
    expect(stdout).toContain('uncaughtException');
    expect(stdout).not.toContain('abcdefghijk');
  });

  it('handles a real unhandled rejection', async () => {
    const { code, stdout } = await runChild('rejection');
    expect(code).toBe(3);
    expect(stdout).toContain('unhandledRejection');
    expect(stdout).not.toContain('hunter2');
  });

  it('exits after timeoutMs when the shutdown hook hangs', async () => {
    const { code, stdout } = await runChild('hang');
    expect(code).toBe(3);
    expect(stdout).not.toContain('SHUTDOWN_HOOK_RAN');
  });
});
