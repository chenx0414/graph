import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';

/**
 * One spelling for the temp directory, in every environment that runs this suite.
 *
 * On macOS `/var` is a symlink to `/private/var`, and the activation gate runs the suite with a TMPDIR
 * of its own, so a test that compares a temp path it built with a path that something else resolved
 * passes in one environment and fails in the other. That mismatch has now cost real time twice (see
 * HB-234 in the harness backlog), and every future test would have to remember realpath() to avoid it.
 * Normalising once here makes the two environments agree instead.
 */
try {
  const real = realpathSync(tmpdir());
  if (real !== tmpdir()) process.env.TMPDIR = real;
} catch {
  // A TMPDIR that cannot be resolved is the environment's problem, not this suite's.
}

/**
 * One window for every `expect.poll`, unless the test asks for its own.
 *
 * Vitest polls for one second by default, which is a coin flip the moment the
 * machine is busy: a real daemon round trip that needs 1.2s fails a correct
 * assertion. The suite had 273 polls without a window, and every time the
 * worker count went up, one of them turned into a "new" flake - the same defect
 * wearing a different test's name each time.
 *
 * Waiting longer does not make a wrong assertion pass: a poll still asserts a
 * fact that must arrive, it just stops failing because the machine was busy.
 * A test that wants a shorter window passes it explicitly.
 */
const defaultPollOptions = { timeout: 30_000, interval: 200 };
const poll = expect.poll.bind(expect);
// The type of poll's options is narrower than a plain record, so the patch is
// cast once here instead of at 273 call sites.
(expect as unknown as { poll: typeof expect.poll }).poll = ((fn: Parameters<typeof poll>[0], options?: Record<string, unknown>) =>
  poll(fn, { ...defaultPollOptions, ...(options ?? {}) })) as typeof expect.poll;
