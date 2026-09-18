import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter } from '../../src/core/types.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function setup(actions: Record<string, ActionAdapter>, limits?: { defaultBudgetTokens?: number | null }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-unlimited-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }], actions, ...(limits ? { limits } : {}) };
  const runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Unlimited work', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Unlimited',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  return { root, options, runtime, taskId, task: runtime.user.task(taskId) };
}

test('a new instance is unlimited and keeps running past the legacy 20M threshold', async () => {
  let sends = 0;
  const { runtime, task } = await setup({
    work: { kind: 'agent', reserveTokens: 20_000_100, prepare: async () => async () => {
      sends += 1;
      // The same instance crosses the old default on its first call; the
      // follow-up round must still be dispatched.
      return { outcome: sends === 1 ? 'continue' : 'completed', output: null, usage: { input: 20_000_001, output: 0, cacheRead: 0, cacheWrite: 0 } };
    } },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: '/tmp/ok', digest: 'a'.repeat(64) } }] }) },
  });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const afterFirst = (await task.view()).nodes.find(node => node.id === 'work')!;
  expect(afterFirst).toMatchObject({ used: 20_000_001, budget: null, unlimited: true });
  // The old 20,000,000 cap must not block the same instance's next round.
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(sends).toBe(2);
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const view = await task.view();
  expect(view.nodes.find(node => node.id === 'work')).toMatchObject({ used: 40_000_002, budget: null, unlimited: true, status: 'succeeded' });
  expect(view.questions.filter(question => question.kind === 'budget')).toHaveLength(0);
  expect(view.phase).toBe('completed');
}, 60_000);

test('a configured finite default still blocks, and an explicit policy change resumes', async () => {
  let sends = 0;
  const { runtime, task } = await setup({
    work: { kind: 'agent', reserveTokens: 1_000, prepare: async () => async () => {
      sends += 1;
      return { outcome: sends === 1 ? 'continue' : 'completed', output: null, usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } };
    } },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: '/tmp/ok', digest: 'a'.repeat(64) } }] }) },
  }, { defaultBudgetTokens: 1_000 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  const blocked = await task.view();
  expect(blocked.nodes.find(node => node.id === 'work')).toMatchObject({ budget: 1_000, unlimited: false, status: 'blocked' });
  expect(blocked.questions).toMatchObject([{ kind: 'budget', nodeId: 'work', status: 'open' }]);

  const receipt = await task.setBudget({ nodeId: 'work', tokens: null, requestId: 'unlimited-work' });
  expect(await task.setBudget({ nodeId: 'work', tokens: null, requestId: 'unlimited-work' })).toEqual(receipt);
  const converted = await task.view();
  expect(converted.questions.filter(question => question.kind === 'budget' && question.status === 'open')).toHaveLength(0);
  expect(converted.nodes.find(node => node.id === 'work')).toMatchObject({ budget: null, unlimited: true, status: 'pending' });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(sends).toBe(2);
}, 60_000);

test('the v14 migration keeps existing finite instances finite and untouched', async () => {
  const { root, options, runtime } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }) },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: '/tmp/ok', digest: 'a'.repeat(64) } }] }) },
  });
  await runtime.close();
  // Rewind the database to the v13 shape with a finite instance carrying usage.
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  db.exec('DROP TABLE IF EXISTS result_handoffs; DROP TABLE IF EXISTS context_resolutions; DROP TABLE IF EXISTS context_handoffs; DROP TABLE IF EXISTS agent_context_bindings; DROP TABLE IF EXISTS budget_scopes; ALTER TABLE instances DROP COLUMN parent_instance_id; ALTER TABLE instances DROP COLUMN budget_scope_id; ALTER TABLE instances DROP COLUMN unlimited; DROP TABLE project_preparation; DROP TABLE presets; DROP TABLE node_entries; DROP TABLE node_sessions; DROP TABLE node_capabilities; ALTER TABLE operations DROP COLUMN dispatched_at; ALTER TABLE operations DROP COLUMN settled_at; ALTER TABLE operations DROP COLUMN waiting_since; ALTER TABLE operations DROP COLUMN waiting_ms; ALTER TABLE nodes DROP COLUMN pause_ms; ALTER TABLE nodes DROP COLUMN pause_since; ALTER TABLE nodes DROP COLUMN user_wait_ms; ALTER TABLE nodes DROP COLUMN user_wait_since; ALTER TABLE invocations DROP COLUMN purpose; DROP INDEX IF EXISTS conversations_archived; ALTER TABLE conversations DROP COLUMN archived_at; ALTER TABLE conversations DROP COLUMN thinking_level; PRAGMA user_version=13;');
  db.prepare('UPDATE instances SET budget=20000000, used=17').run();
  db.close();

  const migrated = await openTaskRuntime(options);
  cleanup.push(() => migrated.close());
  const reopened = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  const row = reopened.prepare('SELECT budget,used,unlimited FROM instances LIMIT 1').get() as { budget: number; used: number; unlimited: number };
  reopened.close();
  expect(row).toEqual({ budget: 20_000_000, used: 17, unlimited: 0 });
}, 60_000);

test('unlimited worker instances continue when usage is missing', async () => {
  const { runtime, task } = await setup({
    work: { kind: 'agent', reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed', output: null, usage: null }) },
    check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: '/tmp/ok', digest: 'a'.repeat(64) } }] }) },
  });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.nodes.find(node => node.id === 'work')).toMatchObject({ unlimited: true, budget: null, status: 'succeeded' });
  // There is no finite cap to protect, so the dependent check can run.
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect((await task.view()).phase).toBe('completed');
}, 60_000);

test('an invalid default budget is rejected instead of guessed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-unlimited-invalid-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await expect(openTaskRuntime({ stateDir: join(root, 'state'), actions: {}, limits: { defaultBudgetTokens: 0 } }))
    .rejects.toMatchObject({ code: 'invalid_input' });
  await expect(openTaskRuntime({ stateDir: join(root, 'state'), actions: {}, limits: { defaultBudgetTokens: -1 } }))
    .rejects.toMatchObject({ code: 'invalid_input' });
}, 30_000);
