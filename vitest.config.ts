import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Ten cores, and the suite spends its time waiting on real daemons rather
    // than on the CPU: two workers left most of the machine idle and made the
    // gate take five minutes. Eight measured 105s against six's 130s, and the
    // only assertion it exposed was a poll window, which is fixed.
    maxWorkers: 8,
    bail: 1,
    include: ['tests/**/*.test.ts'],
    // Gives every test one spelling for the temp directory, whatever TMPDIR the runner was started with.
    setupFiles: ['tests/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
