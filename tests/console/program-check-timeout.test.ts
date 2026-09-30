// How long a program check may run, pinned as behaviour.
//
// Failure mode this file exists for: every `graph.command` check was killed after two minutes, and
// the kill arrived as `Process terminated by SIGKILL` - which reads like a verdict on the work rather
// than a limit the harness imposed. The project's own suite needs about two and a half minutes, so a
// gate that runs it could never finish, whatever it was checking. Measured on task 68543fed: the two
// attempts at that gate were cut at 120s and 133s wall time, and an unsandboxed run of the same
// commit finished in 127-145s.
//
// A check may now declare `timeoutMs`; the default is unchanged, and a run that IS cut says so.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

/** Sleeps for the milliseconds it is given, so a check can be asked to outlive its limit. */
const SLEEP = [
  'const ms = Number(process.argv[2] ?? 0);',
  'setTimeout(() => console.log(`slept ${ms}`), ms);',
  '',
].join('\n');

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-check-timeout-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

/** Writes the sleeper into the lane's work copy, so the check finds it on the integrated result. */
const work: ActionAdapter = {
  kind: 'agent', reserveTokens: 100,
  prepare: async operation => async () => {
    await mkdir(join(operation.workspace!, 'scripts'), { recursive: true });
    await writeFile(join(operation.workspace!, 'scripts', 'sleep.mjs'), SLEEP);
    return { outcome: 'completed', output: null, usage };
  },
};

const nodes: NodeSpec[] = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'] },
];

async function run(root: string, input: unknown) {
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], actions: { work } });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes: nodes.map(node => node.id === 'check' ? { ...node, input: input as import('../../src/core/types.ts').Json } : node),
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  return task.view();
}

/** What the check actually reported, read back from the durable record the harness keeps. */
async function reported(root: string, nodeId: string) {
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  const row = store.db.prepare(`SELECT result FROM operations WHERE node_id=? AND result IS NOT NULL ORDER BY dispatched_at DESC LIMIT 1`)
    .get(nodeId) as { result: string } | undefined;
  store.close();
  return JSON.parse(row!.result) as { outcome: string; output: { code: number | null; stderr: string } };
}

test('a check that finishes inside its declared limit is not killed', async () => {
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/sleep.mjs', '700'], timeoutMs: 30_000 });
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  const body = JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string };
  expect(body.code).toBe(0);
  expect(body.stdout).toContain('slept 700');
});

test('a check that outlives its declared limit is cut, and the record says it was the limit', async () => {
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/sleep.mjs', '30000'], timeoutMs: 2_000 });
  expect(view.nodes.find(node => node.id === 'check')?.status).not.toBe('succeeded');
  // The kill is the harness's own limit, and a reader of the record must be able to tell that apart
  // from the command deciding the work is bad - that difference is what cost two gate attempts.
  const record = await reported(root, 'check');
  expect(record.outcome).toBe('failed');
  expect(record.output.stderr).toContain('timeout');
  expect(record.output.stderr).toContain('2000');
});

test('a limit the harness cannot honour is refused rather than quietly replaced', async () => {
  for (const timeoutMs of [0, -1, 1.5, 'soon']) {
    const root = await repo();
    const view = await run(root, { command: 'node', args: ['scripts/sleep.mjs', '10'], timeoutMs });
    expect(view.nodes.find(node => node.id === 'check')?.status).not.toBe('succeeded');
  }
});
