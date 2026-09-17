import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { validateProposal } from '../../src/core/proposal.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { addInstanceUsage, assertWithinBudget, setInstanceBudget } from '../../src/core/context.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

test('context requests cannot hide transcript inheritance in independent review', () => {
  expect(() => validateProposal({
    requirementVersion: 1,
    summary: 'invalid review context',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'review',
        dependsOn: ['work'],
        context: {
          purpose: 'review',
          sourceNode: 'work',
          requiredFacts: [{ kind: 'transcript_range' }],
          independence: 'model-excluded',
        },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['review'] },
    ],
  })).toThrow(/Independent context cannot include transcript/);

  expect(() => validateProposal({
    requirementVersion: 1,
    summary: 'source must be an ancestor',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'fork', kind: 'agent', action: 'explore', definitionVersion: 'coder@1', model: 'local',
        context: { purpose: 'explore', sourceNode: 'work', requiredFacts: [{ kind: 'transcript_range' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'fork'] },
    ],
  })).toThrow(/dependency ancestor/);
});

test('a fork creates a new session from the source leaf and shares its budget scope', async () => {
  const provider = await openaiServer([
    { text: 'SOURCE_TRANSCRIPT_SENTINEL: inspected the exact failure state.' },
    { text: 'FORK_COMPLETED' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-context-model-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed',
          output: null,
          evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
        }),
      },
    },
    models: {
      entries: [{
        id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
  });
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);

  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'fork exact state', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Fork the exact implementation state for exploration.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'explore', kind: 'agent', action: 'explore', definitionVersion: 'coder@1', model: 'local',
        dependsOn: ['work'],
        context: {
          purpose: 'explore',
          sourceNode: 'work',
          requiredFacts: [{ kind: 'transcript_range' }, { kind: 'tool_call' }],
          reason: 'The exact uns summarized debugging state is required.',
        },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'explore'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const source = runtime.nodeRun(taskId, 'work');
  const fork = runtime.nodeRun(taskId, 'explore');
  expect(source.context).toMatchObject({ selectedMode: 'fresh', initialMode: 'fresh' });
  expect(fork.context).toMatchObject({
    selectedMode: 'fork',
    initialMode: 'fork',
    sourceNodeId: 'work',
    sourceInstanceId: source.instance?.id,
  });
  expect(fork.session?.sessionId).toBeTruthy();
  expect(fork.session?.sessionId).not.toBe(source.session?.sessionId);
  expect(fork.context?.sourceLeafId).toBeTruthy();
  expect(fork.context?.sourceContextDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(fork.context?.childContextDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(fork.context?.childContextDigest).toBe(fork.context?.sourceContextDigest);

  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const scopes = store.db.prepare(`SELECT id,limit_tokens,unlimited,used_tokens FROM budget_scopes
    WHERE id IN (?,?) ORDER BY id`).all(source.context!.budgetScope!.id, fork.context!.budgetScope!.id) as { id: string }[];
  expect(scopes).toHaveLength(1);
  expect(fork.context?.budgetScope?.id).toBe(source.context?.budgetScope?.id);

  const forkRequest = provider.requests.find(request => JSON.stringify(request).includes('SOURCE_TRANSCRIPT_SENTINEL'));
  expect(forkRequest).toBeTruthy();
}, 120_000);

test('a shared budget scope counts usage across source and fork instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-context-budget-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','budget',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','source','{}','i-source')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','fork','{}','i-fork')").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-source','t','source',100,0,0)").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited,parent_instance_id) VALUES('i-fork','t','fork',100,0,0,'i-source')").run();
    store.db.prepare("INSERT INTO budget_scopes(id,task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at) VALUES('scope','t','i-source',100,0,0,0)").run();
    store.db.prepare("UPDATE instances SET budget_scope_id='scope' WHERE id IN ('i-source','i-fork')").run();
  });
  setInstanceBudget(store, 'i-source', 100);
  addInstanceUsage(store, 'i-source', 60);
  expect(() => assertWithinBudget(store, 'i-fork', 41)).toThrow(/Shared context budget/);
  expect(() => assertWithinBudget(store, 'i-fork', 40)).not.toThrow();
});
