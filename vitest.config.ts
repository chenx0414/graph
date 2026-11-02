import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Ten cores, and the suite spends its time waiting on real daemons rather
    // than on the CPU: two workers left most of the machine idle and made the
    // gate take five minutes, six brought it to about 130s.
    //
    // Eight was measured at 105-107s, but it flaked twice in seven runs - both
    // times a test whose own budget was set for six workers ran out of it
    // (go-credential-refusal waiting for a conversation to resume, and
    // orchestration-supervisor-question waiting for a question to resolve).
    // 24 seconds is not worth re-tuning other tests' time budgets, so six stays
    // until those budgets are revisited on purpose.
    maxWorkers: 6,
    bail: 1,
    include: ['tests/**/*.test.ts'],
    // Gives every test one spelling for the temp directory, whatever TMPDIR the runner was started with.
    setupFiles: ['tests/setup.ts'],
    // A test's own budget must not be shorter than the poll window it is
    // allowed to use: tests/setup.ts gives every expect.poll 30s, so a 15s
    // testTimeout could kill a poll that was legitimately still waiting - the
    // red then says "the machine was busy", not "the fact never arrived".
    // Measured 2026-11-01: under six workers two runs of one commit failed in
    // different files, each passing alone.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
