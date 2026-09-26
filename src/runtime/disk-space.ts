import { statfsSync } from 'node:fs';

/**
 * Room packaging needs before it starts. The dmg step failed once with 786 MiB free (`hdiutil: create
 * failed - 设备上无剩余空间`) and passed with 5.1 GiB, and by then the web build and the whole staging
 * copy had already been paid for.
 */
export const MIN_FREE_BYTES = 4 * 1024 ** 3;

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
