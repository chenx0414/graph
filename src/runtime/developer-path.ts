import { existsSync } from 'node:fs';

/**
 * Locations a developer's shell puts on `PATH` but a desktop launch does not.
 *
 * An app started from the desktop inherits launchd's minimal `PATH`
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), where anything needing the developer's own toolchain -
 * `npm`, a package runner, a browser - fails before the work it supports even starts.
 */
export const DEVELOPER_PATH_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin', '/usr/local/sbin'];

/** Keep the inherited order, then append the standard developer locations that exist here. */
export function developerPath(inherited: string | undefined, exists: (path: string) => boolean = existsSync): string {
  const directories = (inherited ?? '').split(':').filter(Boolean);
  for (const directory of DEVELOPER_PATH_DIRECTORIES) {
    if (!directories.includes(directory) && exists(directory)) directories.push(directory);
  }
  return directories.join(':');
}

/**
 * Widen one process environment's `PATH` in place, so every child that process starts
 * resolves the same binaries the user's own shell would. Returns the environment, so the
 * decision is testable without touching the real one.
 */
export function widenProcessPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const widened = developerPath(env.PATH, exists);
  if (widened !== env.PATH) env.PATH = widened;
  return env;
}
