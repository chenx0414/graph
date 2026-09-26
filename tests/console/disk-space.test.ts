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
  expect(MIN_FREE_BYTES).toBe(4 * 1024 ** 3);
});
