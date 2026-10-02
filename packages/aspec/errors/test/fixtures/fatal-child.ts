import { installProcessHandlers } from '../../src/index.js';

const mode = process.argv[2] ?? 'exception';
const lines: string[] = [];
const logger = {
  debug() {},
  info() {},
  warn() {},
  error(obj: Record<string, unknown>, msg?: string) {
    lines.push(JSON.stringify({ msg, obj }));
  },
};

installProcessHandlers({
  logger,
  exitCode: 3,
  timeoutMs: mode === 'hang' ? 50 : 2000,
  onFatal: async () => {
    if (mode === 'hang') await new Promise(() => {});
    await new Promise((r) => setTimeout(r, 10));
    process.stdout.write(`${lines.join('\n')}\nSHUTDOWN_HOOK_RAN\n`);
  },
});

if (mode === 'rejection') {
  void Promise.reject(new Error('rejected with password=hunter2'));
} else {
  setTimeout(() => {
    throw new Error('thrown with Bearer abcdefghijk');
  }, 1);
}
