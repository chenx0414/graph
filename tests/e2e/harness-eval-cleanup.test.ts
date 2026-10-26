import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
const repo = process.cwd();

/**
 * A killed evaluation must not cost the next one its disk.
 *
 * The evaluation removes its temporary root in a `finally`, which does not run
 * when the process is killed - and a killed run is the normal case here: a
 * freeze that exceeds its ceiling, an interrupted run. Each attempt leaves the
 * whole harness home behind (measured 2.5 GB), and enough of them fill the
 * disk for everything else on the machine. The next run therefore sweeps what
 * earlier runs could not, and it must not sweep a run that is still going.
 */
test('a run sweeps the temporary roots an earlier killed run left behind, and keeps a live one', async () => {
  const base = tmpdir();
  const stale = await mkdtemp(join(base, 'graph-harness-eval-stale-'));
  const live = await mkdtemp(join(base, 'graph-real-eval-live-'));
  const untouched = await mkdtemp(join(base, 'graph-unrelated-stale-'));
  await mkdir(join(stale, 'surface'), { recursive: true });
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await utimes(stale, sevenHoursAgo, sevenHoursAgo);
  await utimes(untouched, sevenHoursAgo, sevenHoursAgo);

  try {
    // A run that stops before the freeze: the sweep happens first, so this
    // really is "the next run" for anything an earlier one left behind.
    const failure = await execute(process.execPath, ['scripts/harness-eval-report.mjs', '--config', join(base, 'no-such-config.json')], { cwd: repo })
      .then(() => null, error => error as { code?: number; stderr?: string });
    expect(failure, 'the run must refuse a config that does not exist').not.toBeNull();
    expect(String(failure?.stderr ?? '')).toMatch(/does not exist/i);

    // The killed run's root is gone...
    await expect(stat(stale)).rejects.toThrow();
    // ...a root young enough to belong to a live run stays...
    expect((await stat(live)).isDirectory()).toBe(true);
    // ...and a directory this tool never created stays out of it.
    expect((await stat(untouched)).isDirectory()).toBe(true);
  } finally {
    await rm(live, { recursive: true, force: true });
    await rm(untouched, { recursive: true, force: true });
    await rm(stale, { recursive: true, force: true });
  }
}, 60000);
