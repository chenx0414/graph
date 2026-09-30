import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { git, revParse } from '../git/git.ts';

/**
 * Where a check that runs the project's own command has to run.
 *
 * A node's work copy is created under the host's state directory, and that place
 * is fine for an Agent's own tools. It is not a place the project's own command
 * can run: `node --run check` is the project's suite, and that suite is not
 * location independent. It reads sibling repositories next to the project root
 * (one page fixture copies a file out of `../12-MediaBookmarks`), and it hands
 * `node_modules` to the sandbox as a grant, which the sandbox refuses unless the
 * path is already canonical - so a linked `node_modules` reads back as a
 * different path and every sandboxed test fails to start. Measured on one
 * checkout of this repository: 127 of 1480 tests fail under the state directory,
 * 0 fail in a prepared copy beside the project root.
 *
 * So a check that declares it wants the project copy runs in a fresh worktree
 * beside the project root, with the project's dependencies hardlinked in rather
 * than linked: hardlinks are ordinary files under the copy, so the grant is
 * canonical and the copy still shares the one install.
 *
 * The copy is keyed on the committed state it was made from and reused while
 * that commit is unchanged, so a retry does not pay to rebuild it. It is a
 * working space, not a deliverable: a check's own evidence is written to its
 * scratch directory, not here. See docs/design-graph-examples.md.
 */
export interface ProjectCopyOptions {
  /** The project's own checkout; its parent also holds the siblings a suite may read. */
  projectRoot: string;
  /** The node's work copy: the committed state the check must run against. */
  source: string;
  /** Tells apart the copies of two checks of the same project. */
  label: string;
}

/** The directory a check's project copy lives in. Deterministic, so retries reuse it. */
export function projectCopyPath(projectRoot: string, label: string) {
  const root = resolve(projectRoot);
  return join(dirname(root), `.graph-check-${basename(root)}-${label}`);
}

export async function prepareProjectCopy(options: ProjectCopyOptions): Promise<string | undefined> {
  const root = resolve(options.projectRoot);
  // Only committed state can be checked out elsewhere. A work copy that never
  // committed has no version to run the project's command against, and the
  // caller reports that instead of quietly running against something else.
  const commit = revParse(options.source, 'HEAD');
  if (!commit) return undefined;
  const dest = projectCopyPath(root, options.label);
  if (revParse(dest, 'HEAD') === commit && existsSync(join(dest, 'node_modules'))) return dest;
  if (existsSync(dest)) {
    // A copy from an earlier commit, or one left half-made by an interrupted
    // run: replace it rather than run the project's command against it.
    git(root, ['worktree', 'remove', '--force', '--', dest]);
    rmSync(dest, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
  const added = git(root, ['worktree', 'add', '--detach', '--', dest, commit]);
  if (added.code !== 0) return undefined;
  linkDependencies(join(root, 'node_modules'), join(dest, 'node_modules'));
  return dest;
}

/**
 * Hardlink the one install into the copy. `-R` walks the tree, `-l` links each
 * file, so the copy holds real files that share the project's blocks. A missing
 * install is not an error here: the command reports its own resolution failure.
 */
function linkDependencies(from: string, to: string) {
  if (!existsSync(from) || existsSync(to)) return;
  try { execFileSync('/bin/cp', ['-Rl', from, to], { stdio: 'ignore' }); }
  catch { /* The command reports its own resolution failure. */ }
}
