import { execFileSync } from 'node:child_process';

export const APP_BUILD_BRANCH = 'main';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function succeeds(root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

export function assertMainBuildSource(root) {
  if (!succeeds(root, ['rev-parse', '--verify', '--quiet', APP_BUILD_BRANCH])) {
    throw new Error(`Graph.app builds only from ${APP_BUILD_BRANCH}, and this checkout has no ${APP_BUILD_BRANCH} branch`);
  }
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === APP_BUILD_BRANCH) return APP_BUILD_BRANCH;
  const head = git(root, ['rev-parse', 'HEAD']);
  if (branch !== 'HEAD') {
    throw new Error(`Graph.app builds only from ${APP_BUILD_BRANCH}, and this checkout is on ${branch}`);
  }
  if (succeeds(root, ['merge-base', '--is-ancestor', 'HEAD', APP_BUILD_BRANCH])) return APP_BUILD_BRANCH;
  throw new Error(`Graph.app builds only from ${APP_BUILD_BRANCH}, and this detached build source is ${head.slice(0, 8)}, which ${APP_BUILD_BRANCH} does not contain`);
}
