import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
