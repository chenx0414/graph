import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, mergeConflictFiles, revParse } from './git.ts';

/**
 * Resolving a collision between two lanes.
 *
 * The automatic path merges a lane's branch into the task integration branch and, when the two
 * sides touch the same lines, stops: the merge is aborted and the task blocks with `git_conflict`.
 * That rule exists because a merge result invented by a model is worse than an honest stop.
 *
 * This module adds the one thing that was missing - a bounded attempt at a *real* merge - without
 * giving up the rule. It hands an agent the two versions of each conflicted file inside the
 * integration worktree and accepts an outcome only if it satisfies Git's own definition of a
 * merge of the two sides:
 *
 * - both sides' changes must still be present: a resolution that silently drops one lane's work is
 *   a rewrite of that lane, not a merge;
 * - nothing outside the conflicted paths may change: a merge agent owns the conflict, not the tree;
 * - a resolution that cannot be verified is discarded and the task blocks exactly as before.
 *
 * The attempt never touches either lane's own branch: it happens in the integration worktree, and
 * the only durable artefact is the merge commit that passes the checks below.
 */

export interface ConflictAttemptInput {
  /** The integration worktree where the merge is attempted. */
  integrationPath: string;
  /** The lane branch being merged in. */
  laneRef: string;
  /** The batch of file contents to put in front of the agent, one prompt for one collision. */
  prompt: (input: { ours: SideFile[]; theirs: SideFile[]; base: SideFile[] }) => string;
  /** The agent turn: it edits files in `integrationPath` and returns when it stops. */
  run: (prompt: string, workspace: string) => Promise<void>;
}

export interface SideFile {
  path: string;
  content: string | null;
  /** True when the file exists at all on this side; a deleted file is a real side of a conflict. */
  exists: boolean;
}

export interface ConflictAttemptResult {
  status: 'merged' | 'blocked';
  sha?: string;
  /** Present when blocked: why the attempt was refused, in the operator's terms. */
  reason?: string;
  conflicts?: string[];
}

/** The bytes of one conflicted path on one side of the merge. */
export async function sideFile(workspace: string, ref: string, path: string): Promise<SideFile> {
  const exists = git(workspace, ['cat-file', '-e', `${ref}:${path}`]).code === 0;
  if (!exists) return { path, exists: false, content: null };
  const shown = git(workspace, ['show', `${ref}:${path}`]);
  return { path, exists: true, content: shown.code === 0 ? shown.stdout : null };
}

export interface ConflictStart {
  ok: boolean;
  conflicts: string[];
}

/** Start the merge without resolving it, leaving the conflicted files in the worktree. */
export function startConflictMerge(integrationPath: string, laneRef: string): ConflictStart {
  const merged = git(integrationPath, ['merge', '--no-edit', '--no-verify', '--no-commit', '--', laneRef]);
  if (merged.code === 0) return { ok: true, conflicts: [] };
  const conflicts = mergeConflictFiles(integrationPath);
  if (!conflicts.length) {
    // Git refused for a reason that is not a content conflict; nothing to resolve.
    git(integrationPath, ['merge', '--abort']);
    return { ok: false, conflicts: [] };
  }
  return { ok: false, conflicts };
}

/**
 * Run one bounded merge attempt.
 *
 * The merge is left in place for the agent to edit, then judged: every conflicted path must be
 * resolved, both sides must still be represented, and no other path may move. A failed judgement
 * aborts the merge, so the integration branch is exactly where it was.
 */
export async function attemptConflictMerge(input: ConflictAttemptInput): Promise<ConflictAttemptResult> {
  const before = revParse(input.integrationPath, 'HEAD');
  if (!before) return { status: 'blocked', reason: 'The integration worktree has no commit' };

  const started = startConflictMerge(input.integrationPath, input.laneRef);
  if (started.ok) {
    // Git merged cleanly (a fast-forward included): the outcome is the same as the automatic path.
    const head = revParse(input.integrationPath, 'HEAD');
    if (git(input.integrationPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0) {
      const committed = git(input.integrationPath, ['commit', '--no-edit', '--no-verify']);
      if (committed.code !== 0) return { status: 'blocked', reason: 'A clean merge could not be committed' };
    }
    const sha = revParse(input.integrationPath, 'HEAD');
    if (sha && sha !== before) return { status: 'merged', sha };
    return head && head !== before
      ? { status: 'merged', sha: head }
      : { status: 'blocked', reason: 'The merge produced no new commit' };
  }
  if (!started.conflicts.length) return { status: 'blocked', reason: 'The merge was refused for a reason other than a content conflict' };

  const conflicted = started.conflicts;
  const oursRef = before;
  const theirsRef = input.laneRef;
  const base = git(input.integrationPath, ['merge-base', before, input.laneRef]);
  const baseRef = base.code === 0 ? base.stdout.trim() : '';
  // Give the agent both sides and the common ancestor for each conflicted path.
  const sides = await Promise.all(conflicted.map(async path => ({
    path,
    ours: await sideFile(input.integrationPath, oursRef, path),
    theirs: await sideFile(input.integrationPath, theirsRef, path),
    base: baseRef ? await sideFile(input.integrationPath, baseRef, path) : { path, exists: false, content: null },
  })));

  try {
    await input.run(
      input.prompt({ ours: sides.map(side => side.ours), theirs: sides.map(side => side.theirs), base: sides.map(side => side.base) }),
      input.integrationPath,
    );
  } catch (error) {
    git(input.integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: `The merge Agent failed: ${String(error)}`, conflicts: conflicted };
  }

  return judgeResolution(input.integrationPath, { before, conflicts: conflicted, sides });
}

/**
 * Accept a resolution only when it is a real merge of both sides.
 *
 * Git's own merge of the two sides is the reference: every change each side made to a conflicted
 * path must survive somewhere in the resolved file. A resolution that drops one side's text is
 * refused, which is the machine-checkable form of "never let a model overwrite a lane".
 */
export async function judgeResolution(
  integrationPath: string,
  input: { before: string; conflicts: string[]; sides: { path: string; ours: SideFile; theirs: SideFile }[] },
): Promise<ConflictAttemptResult> {
  // Resolving a conflict means leaving the file resolved *and staged*, which is what an agent's
  // file write alone does not do. Staging first is what makes Git's own unresolved-file list the
  // authority on whether the conflict is really gone.
  const resolvedPaths = input.conflicts.filter(path => existsSync(join(integrationPath, path)));
  if (resolvedPaths.length) git(integrationPath, ['add', '--', ...resolvedPaths]);
  const stillConflicted = mergeConflictFiles(integrationPath);
  if (stillConflicted.length) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: 'The merge Agent left conflicts unresolved', conflicts: stillConflicted };
  }
  // Staging can hide the markers: a file the agent saved with conflict markers still in it is
  // staged cleanly by Git, and committing it would ship the markers into the integration branch.
  const marked: string[] = [];
  for (const path of resolvedPaths) {
    const text = await readFile(join(integrationPath, path), 'utf8');
    if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) marked.push(path);
  }
  if (marked.length) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: `The merge Agent left conflict markers in ${[...new Set(marked)].join(', ')}`, conflicts: [...new Set(marked)] };
  }
  // Nothing outside the conflicted paths may move: the merge agent owns the conflict, not the tree.
  const moved = git(integrationPath, ['diff', '--name-only', input.before]);  if (moved.code !== 0) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: 'The worktree could not be compared with the merge base' };
  }
  const touched = moved.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  const foreign = touched.filter(path => !input.conflicts.includes(path));
  if (foreign.length) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: `The merge Agent changed paths outside the conflict: ${foreign.join(', ')}`, conflicts: foreign };
  }

  // Both sides must survive. A side's added lines are its contribution; the union of both sides'
  // added lines must all appear in the resolved file.
  const missing: string[] = [];
  for (const side of input.sides) {
    const resolved = existsSync(join(integrationPath, side.path)) ? await readFile(join(integrationPath, side.path), 'utf8') : '';
    for (const line of contributions(side.ours.content, side.theirs.content, side.ours.content)) {
      if (!resolved.includes(line)) missing.push(side.path);
    }
  }
  if (missing.length) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: `A side of the conflict was dropped from ${[...new Set(missing)].join(', ')}`, conflicts: [...new Set(missing)] };
  }

  const committed = git(integrationPath, ['commit', '--no-edit', '--no-verify']);
  if (committed.code !== 0) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: 'The verified resolution could not be committed' };
  }
  const sha = revParse(integrationPath, 'HEAD');
  if (!sha || sha === input.before) {
    git(integrationPath, ['merge', '--abort']);
    return { status: 'blocked', reason: 'The merge produced no new commit' };
  }
  return { status: 'merged', sha };
}

/** The lines one side contributes to a path: present in that side, absent from the other. */
export function contributions(ours: string | null, theirs: string | null, resolved: string | null): string[] {
  void resolved;
  const left = new Set(lines(ours));
  const right = new Set(lines(theirs));
  const onlyLeft = [...left].filter(line => line.trim() && !right.has(line));
  const onlyRight = [...right].filter(line => line.trim() && !left.has(line));
  return [...new Set([...onlyLeft, ...onlyRight])];
}

function lines(content: string | null): string[] {
  return content === null ? [] : content.split('\n');
}
