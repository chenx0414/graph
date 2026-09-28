import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Which code the running daemon is actually executing.
 *
 * This exists because "I committed it" and "the app runs it" are different facts, and the gap
 * between them has already cost real time twice: once when a console served a page from a fresh
 * web bundle while its server routes came from a process started hours earlier, and once when a
 * change was committed to one checkout while the daemon loaded its source from another. Reading
 * the answer off the process instead of guessing is the whole point of this module.
 *
 * It is read **once, at startup**, because that is exactly the lifetime of the fact: the daemon
 * loads its source when it starts and never swaps it afterwards. Re-reading on every request would
 * invite the opposite error - showing a commit the process is not running.
 */
export interface SourceIdentity {
  /** The checkout (or packaged app root) the running code was loaded from. */
  root: string;
  /** Full commit SHA, or null when the root is not a Git checkout or git is unavailable. */
  commit: string | null;
  /** Short branch name, or null when detached or unknown. */
  branch: string | null;
  /** Whether the checkout had uncommitted changes at startup; null when it could not be read. */
  dirty: boolean | null;
}

/**
 * Run git and report both whether it worked and what it said.
 *
 * The two must stay separate: a clean `git status --porcelain` prints nothing *and succeeded*, so
 * collapsing empty output into failure would report a clean checkout as unknown - the opposite of
 * the truth this module exists to tell.
 */
function run(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const output = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, out: output.trim() };
  } catch {
    // No git, not a repository, or a detached/bare corner: the honest answer is "unknown".
    return { ok: false, out: '' };
  }
}

/**
 * Read the running source identity.
 *
 * A packaged app has no `.git`, so every field except the root comes back unknown rather than
 * invented. That is the correct reading: a packaged bundle is not a commit, and pretending it is
 * would recreate the confusion this module removes.
 */
export function readSourceIdentity(root: string): SourceIdentity {
  if (!existsSync(join(root, 'package.json'))) {
    return { root, commit: null, branch: null, dirty: null };
  }
  const commit = run(root, ['rev-parse', 'HEAD']);
  const branch = run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(root, ['status', '--porcelain']);
  return {
    root,
    commit: commit.ok && commit.out.length ? commit.out : null,
    // A detached HEAD reports the literal "HEAD"; that is not a branch name.
    branch: branch.ok && branch.out && branch.out !== 'HEAD' ? branch.out : null,
    dirty: status.ok ? status.out.length > 0 : null,
  };
}

/** A short form of the commit for display, or the honest "unknown". */
export function shortCommit(identity: SourceIdentity): string {
  return identity.commit ? identity.commit.slice(0, 12) : '未知';
}
