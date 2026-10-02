import { defineAspecVitestConfig } from './src/coverage.js';

export default defineAspecVitestConfig({
  setupFiles: ['test/setup.ts'],
  coverage: {
    thresholds: false,
    enabled: false,
  },
});
