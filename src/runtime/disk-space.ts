import { statfsSync } from 'node:fs';

/**
 * Room packaging needs before it starts, measured rather than guessed: one build leaves 778 MiB of output
 * (583 MiB app bundle + 195 MiB dmg), and the dmg step failed once at 786 MiB free (`hdiutil: create
 * failed - 设备上无剩余空间`) — by which point the web build and the whole staging copy had already been
 * paid for. At 4 GiB the message fired on builds that then passed three times in a row at 3.2–3.7 GiB
 * free; a warning that cries wolf costs the user a clean-up it did not need.
 */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

/** Sizes the way a person reads them back off `df -h`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Free space on the volume that holds `path`. */
export function freeBytesAt(path: string): number {
  const stats = statfsSync(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * What to print before packaging, or null when there is room. Deliberately a message and not a throw:
 * the check reports what it found and what can be reclaimed, and the build decides for itself.
 */
export function diskSpaceWarning(freeBytes: number, neededBytes: number = MIN_FREE_BYTES): string | null {
  if (freeBytes >= neededBytes) return null;
  return [
    `app:build 只剩 ${formatBytes(freeBytes)} 可用空间，打包约需 ${formatBytes(neededBytes)}；dmg 步骤很可能以「设备上无剩余空间」失败。`,
    '先回收再重跑：~/.agent-browser/tmp（最大可回收项，GB 量级）、.stage、旧的 dist/app。',
  ].join('\n');
}
