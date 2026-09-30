// Where a program check runs, pinned as behaviour (R24: failure modes first).
//
// Failure mode this file exists for: the confirmed gate that runs the project's own suite could not
// finish inside the OS sandbox. Measured 2026-09-30 on task 68543fed, same copy and same
// `node --run check`: outside the sandbox 1480/1480 passed, inside it 224 failed / 49 passed, mostly
// the suite's own 15s timeouts - the sandbox makes every child process slow enough that the suite
// fails for reasons that have nothing to do with the work. A gate nobody can trust is not a gate.
//
// So `graph.command` may now declare `sandbox: false`, which runs the command the way the project
// itself runs it: a direct process, the host environment, no seatbelt. The declaration is honoured
// ONLY under full access - the command comes from the confirmed graph, and under full access an Agent
// can already run host commands; anything less must refuse rather than quietly downgrade.
//
// 1. Under standard access a `sandbox: false` check is refused, and the refusal says why.
// 2. Under full access it really runs outside the sandbox (proven by the host environment reaching
//    the child, which the sandboxed path deliberately does not pass on).
// 3. Declaring nothing keeps the old behaviour: sandboxed.
// 4. The record says which way it ran, so evidence carries its own shape.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import type { ActionAdapter, Json, NodeSpec } from '../../src/core/types.ts';
import { git as runGit } from '../../src/git/git.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
  delete process.env.GRAPH_UNSANDBOXED_PROBE;
});
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

/** The variable the host process holds and the sandboxed child is deliberately not given. */
const PROBE = 'GRAPH_UNSANDBOXED_PROBE';

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-check-sandbox-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

/** Prints what the host environment gave it - and nothing else can. */
const PROBE_SCRIPT = 'console.log(`probe=${process.env.GRAPH_UNSANDBOXED_PROBE ?? \'absent\'}`);\n';

const work: ActionAdapter = {
  kind: 'agent', reserveTokens: 100,
  prepare: async operation => async () => {
    await mkdir(join(operation.workspace!, 'scripts'), { recursive: true });
    await writeFile(join(operation.workspace!, 'scripts', 'probe.mjs'), PROBE_SCRIPT);
    return { outcome: 'completed', output: null, usage };
  },
};

const nodes: NodeSpec[] = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'] },
];

async function run(root: string, input: unknown, options: { fullAccess?: boolean } = {}) {
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'project', root }],
    actions: { work },
    ...(options.fullAccess ? { access: () => fullAccessPolicy() } : {}),
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Run the check',
    acceptance: [{ id: 'tests', description: 'Tests pass', checkNode: 'check' }],
    nodes: nodes.map(node => node.id === 'check' ? { ...node, input: input as Json } : node),
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
  return JSON.parse(row!.result) as { outcome: string; output: Record<string, unknown> };
}

/**
 * Why a check was refused before it ever ran. A refusal that leaves no readable reason is worse than
 * one that runs: the author would have nothing to fix.
 */
async function refusal(root: string, nodeId: string) {
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  const row = store.db.prepare("SELECT data FROM questions WHERE node_id=? AND kind='adapter_error' ORDER BY rowid DESC LIMIT 1")
    .get(nodeId) as { data: string } | undefined;
  store.close();
  return row ? JSON.parse(row.data) as { reason?: string } : undefined;
}

async function recordBody(view: Awaited<ReturnType<typeof run>>) {
  const evidence = view.evidence.find(item => item.acceptanceId === 'tests');
  return JSON.parse(await readFile(evidence!.artifact.path, 'utf8')) as { code: number; stdout: string; sandboxed?: boolean };
}

test('under standard access, asking to run outside the sandbox is refused and says why', async () => {
  process.env[PROBE] = 'visible-in-host';
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], sandbox: false });
  expect(view.nodes.find(node => node.id === 'check')?.status).not.toBe('succeeded');
  // A silent downgrade would be worse than a refusal: the author would believe the check ran the way
  // it was written. The message has to name the missing precondition.
  const said = await refusal(root, 'check');
  expect(said?.reason).toMatch(/full access/);
});

test('under full access it really runs outside the sandbox, and the record says so', async () => {
  process.env[PROBE] = 'visible-in-host';
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], sandbox: false }, { fullAccess: true });
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const body = await recordBody(view);
  // The host environment reached the child. The sandboxed path builds its own environment and never
  // passes this variable on, so this is a measurement of which mechanism ran the command.
  expect(body.stdout).toContain('probe=visible-in-host');
  expect(body.sandboxed).toBe(false);
});

test('declaring nothing keeps the check inside the sandbox', async () => {
  process.env[PROBE] = 'visible-in-host';
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'] }, { fullAccess: true });
  expect(view.nodes.find(node => node.id === 'check')?.status).toBe('succeeded');
  const body = await recordBody(view);
  expect(body.stdout).toContain('probe=absent');
  expect(body.sandboxed).toBe(true);
});

test('a sandbox declaration that is not a boolean is refused rather than guessed at', async () => {
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], sandbox: 'no' }, { fullAccess: true });
  expect(view.nodes.find(node => node.id === 'check')?.status).not.toBe('succeeded');
  expect((await refusal(root, 'check'))?.reason).toMatch(/sandbox must be true or false/);
});
