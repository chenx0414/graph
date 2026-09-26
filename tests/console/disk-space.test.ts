import { expect, test } from 'vitest';
import { MIN_FREE_BYTES, diskSpaceWarning, formatBytes } from '../../src/runtime/disk-space.ts';

/**
 * Packaging once died at the dmg step (`hdiutil: create failed - 设备上无剩余空间`) after the web build
 * and the whole staging copy, and the only hint was that error. The check that reports this is
 * deliberately non-blocking: it states the space it found and names what to reclaim, so a build that
 * cannot finish says so before it spends the time.
 */
test('packaging warns below the threshold and names what to reclaim', () => {
  expect(diskSpaceWarning(MIN_FREE_BYTES)).toBeNull();
  expect(diskSpaceWarning(MIN_FREE_BYTES * 4)).toBeNull();

  const warning = diskSpaceWarning(786 * 1024 ** 2);
  expect(warning).not.toBeNull();
  // The size that actually failed, so the message can be recognised from the failure it explains.
  expect(warning).toContain('786 MiB');
  expect(warning).toContain('.agent-browser/tmp');
  expect(warning).toContain('app:build');
});

test('space is reported in the unit a human reads', () => {
  expect(formatBytes(5.1 * 1024 ** 3)).toBe('5.1 GiB');
  expect(formatBytes(786 * 1024 ** 2)).toBe('786 MiB');
  // The threshold is measured rather than guessed: one build leaves 778 MiB of output (583 MiB app +
  // 195 MiB dmg) and the build that died did so at 786 MiB free, so 2 GiB is the same early warning with
  // room to spare. The 4 GiB it used to be cried wolf on three builds that passed at 3.2–3.7 GiB free.
  expect(MIN_FREE_BYTES).toBe(2 * 1024 ** 3);
});

test('the warning still arrives before the failure, and stays quiet at a size that has worked', () => {
  // The size that actually failed.
  expect(diskSpaceWarning(786 * 1024 ** 2)).not.toBeNull();
  // Three consecutive builds that passed at this size.
  expect(diskSpaceWarning(3.2 * 1024 ** 3)).toBeNull();
});
