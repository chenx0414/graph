import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { attemptConflictMerge, contributions } from '../../src/git/conflict-merge.ts';
import { git } from '../../src/git/git.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/** A repository with a task branch (ours) and a lane branch (theirs) that collide on one line. */
async function colliding(files: Record<string, string> = { 'shared.ts': 'a\nb\nc\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-conflict-merge-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'integration');
  await mkdir(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'g@l']);
  git(work, ['config', 'user.name', 'G']);
  for (const [path, content] of Object.entries(files)) await writeFile(join(work, path), content);
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'base']);
  // Theirs changes the middle line, ours changes it differently: a same-line collision.
  git(work, ['checkout', '-q', '-b', 'lane']);
  await writeFile(join(work, 'shared.ts'), files['shared.ts']!.replace('b', 'from-lane'));
  git(work, ['commit', '-aqm', 'lane']);
  git(work, ['checkout', '-q', 'main']);
  await writeFile(join(work, 'shared.ts'), files['shared.ts']!.replace('b', 'from-main'));
  git(work, ['commit', '-aqm', 'main']);
  return { root, work };
}

const prompt = (input: { ours: { path: string; content: string | null }[]; theirs: { path: string; content: string | null }[] }) =>
  `resolve ${input.ours.map(side => side.path).join(', ')}`;

test('a real merge that keeps both sides is committed, and it is a merge of the two branches', async () => {
  const { work } = await colliding();
  const result = await attemptConflictMerge({
    integrationPath: work,
    laneRef: 'lane',
    prompt,
    // The agent writes a resolution that carries both lanes' text.
    run: async (_prompt, workspace) => { await writeFile(join(workspace, 'shared.ts'), 'a\nfrom-main\nfrom-lane\nc\n'); },
  });
  expect(result.status).toBe('merged');
  expect(git(work, ['show', 'HEAD:shared.ts']).stdout).toBe('a\nfrom-main\nfrom-lane\nc');
  // The commit is a real merge: it has exactly two parents, ours and the lane's tip.
  const parents = git(work, ['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(/\s+/);
  expect(parents).toHaveLength(3);
  expect(parents).toContain(git(work, ['rev-parse', 'lane']).stdout.trim());
  expect(git(work, ['status', '--porcelain']).stdout).toBe('');
});

test('a resolution that silently drops one lane is refused and the merge is aborted', async () => {
  const { work } = await colliding();
  const before = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const result = await attemptConflictMerge({
    integrationPath: work,
    laneRef: 'lane',
    prompt,
    // The agent overwrites with only its own side: exactly the "model improvises a rewrite" case.
    run: async (_prompt, workspace) => { await writeFile(join(workspace, 'shared.ts'), 'a\nfrom-main\nc\n'); },
  });
  expect(result.status).toBe('blocked');
  expect(result.reason).toMatch(/dropped/i);
  expect(git(work, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
  expect(git(work, ['status', '--porcelain']).stdout).toBe('');
});

test('an agent that edits a path outside the conflict is refused', async () => {
  const { work } = await colliding({ 'shared.ts': 'a\nb\nc\n', 'other.ts': 'untouched\n' });
  const before = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const result = await attemptConflictMerge({
    integrationPath: work,
    laneRef: 'lane',
    prompt,
    run: async (_prompt, workspace) => {
      await writeFile(join(workspace, 'shared.ts'), 'a\nfrom-main\nfrom-lane\nc\n');
      await writeFile(join(workspace, 'other.ts'), 'sneaky change\n');
    },
  });
  expect(result.status).toBe('blocked');
  expect(result.reason).toMatch(/outside the conflict/i);
  expect(git(work, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
  expect(git(work, ['show', 'HEAD:other.ts']).stdout).toBe('untouched');
});

test('an agent that leaves the conflict markers in place is refused', async () => {
  const { work } = await colliding();
  const before = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const result = await attemptConflictMerge({
    integrationPath: work,
    laneRef: 'lane',
    prompt,
    // Writes an "I give up" file that still holds both markers rather than resolving them.
    run: async (_prompt, workspace) => { await writeFile(join(workspace, 'shared.ts'), 'a\n<<<<<<< HEAD\nfrom-main\n=======\nfrom-lane\n>>>>>>> lane\nc\n'); },
  });
  expect(result.status).toBe('blocked');
  expect(git(work, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
});

test('an agent that fails leaves the integration branch untouched', async () => {
  const { work } = await colliding();
  const before = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const result = await attemptConflictMerge({
    integrationPath: work,
    laneRef: 'lane',
    prompt,
    run: async () => { throw new Error('provider exploded'); },
  });
  expect(result.status).toBe('blocked');
  expect(result.reason).toMatch(/merge Agent failed/i);
  expect(git(work, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
  expect(git(work, ['status', '--porcelain']).stdout).toBe('');
});

test('two lanes that do not collide never reach the agent at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-conflict-clean-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'integration');
  await mkdir(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'g@l']);
  git(work, ['config', 'user.name', 'G']);
  await writeFile(join(work, 'a.ts'), 'a\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'base']);
  git(work, ['checkout', '-q', '-b', 'lane']);
  await writeFile(join(work, 'b.ts'), 'b\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-qm', 'lane']);
  git(work, ['checkout', '-q', 'main']);

  let agentRan = false;
  const result = await attemptConflictMerge({
    integrationPath: work,
    laneRef: 'lane',
    prompt,
    run: async () => { agentRan = true; },
  });
  expect(result.status).toBe('merged');
  expect(agentRan).toBe(false);
  expect(git(work, ['show', 'HEAD:b.ts']).stdout).toBe('b');
});

test('the contributed lines of both sides are what the resolution must preserve', () => {
  expect(contributions('a\nb\nc\n', 'a\nX\nc\n', null).sort()).toEqual(['X', 'b']);
  expect(contributions(null, 'a\nb\n', null)).toEqual(['a', 'b']);
  expect(contributions('same\n', 'same\n', null)).toEqual([]);
});
