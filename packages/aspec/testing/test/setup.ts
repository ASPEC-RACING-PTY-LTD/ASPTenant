import { afterEach } from 'vitest';
import { cleanupAll, resetSequences, setSeed } from '../src/index.js';

setSeed('aspec-testing-suite');

afterEach(async () => {
  resetSequences();
  await cleanupAll();
});
