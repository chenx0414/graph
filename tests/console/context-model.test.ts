import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { validateProposal } from '../../src/core/proposal.ts';
import { canonicalJson, TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import {
  addInstanceUsage,
  assertWithinBudget,
  contextView,
  freezeContextHandoff,
  recordContextSession,
  resolveAgentContext,
  setInstanceBudget,
} from '../../src/core/context.ts';
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

test('fresh, continue and rejected context resolutions produce the correct events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-context-events-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','events',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','continued','{}','i-continued')").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','fresh','{}','i-fresh')").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-continued','t','continued',100,0,0)").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-fresh','t','fresh',100,0,0)").run();
    store.db.prepare("INSERT INTO node_sessions(instance_id,session_id,session_file,updated_at) VALUES('i-continued','s-continued','/tmp/s-continued.jsonl',0)").run();
  });

  const continuedSpec = { id: 'continued', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local' };
  const continued = resolveAgentContext(store, { taskId: 't', nodeId: 'continued', spec: continuedSpec, review: false });
  expect(continued.mode).toBe('continue');
  store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES('op-continued','t','continued','i-continued',1,?,'intent',0,'a')").run(canonicalJson(continuedSpec));
  freezeContextHandoff(store, continued, {
    taskId: 't', operationId: 'op-continued', nodeId: 'continued', instanceId: 'i-continued', summary: '继续', package: { briefing: '继续' },
  });
  recordContextSession(store, {
    taskId: 't', nodeId: 'continued', operationId: 'op-continued', bindingId: continued.bindingId,
    sessionId: 's-continued', childContextDigest: 'd'.repeat(64),
  });
  expect(contextView(store, 't', 'continued')?.selectedMode).toBe('continue');

  const freshSpec = { id: 'fresh', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local' };
  const fresh = resolveAgentContext(store, { taskId: 't', nodeId: 'fresh', spec: freshSpec, review: false });
  expect(fresh.mode).toBe('fresh');
  store.db.prepare("INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id) VALUES('op-fresh','t','fresh','i-fresh',1,?,'intent',0,'b')").run(canonicalJson(freshSpec));
  freezeContextHandoff(store, fresh, {
    taskId: 't', operationId: 'op-fresh', nodeId: 'fresh', instanceId: 'i-fresh', summary: '全新', package: { briefing: '全新' },
  });
  recordContextSession(store, {
    taskId: 't', nodeId: 'fresh', operationId: 'op-fresh', bindingId: fresh.bindingId,
    sessionId: 's-fresh', childContextDigest: 'e'.repeat(64),
  });

  const branchEvents = store.db.prepare("SELECT type,json_extract(data,'$.nodeId') AS nodeId FROM events WHERE type IN ('context.branch_created','context.branch_resumed') ORDER BY cursor").all() as { type: string; nodeId: string }[];
  expect(branchEvents).toEqual([{ type: 'context.branch_resumed', nodeId: 'continued' }]);
});

test('a runtime context rejection is visible as an event and does not send the rejected Agent', async () => {
  const provider = await openaiServer([{ text: 'SOURCE_ONLY' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-context-rejected-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    actions: {
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null }) },
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
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'reject fork', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Reject a fork that changes the Agent definition without rebrand.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'source', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'rejected', kind: 'agent', action: 'explore', definitionVersion: 'tester@1', model: 'local',
        dependsOn: ['source'],
        context: { purpose: 'explore', sourceNode: 'source', requiredFacts: [{ kind: 'transcript_range' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['source', 'rejected'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(provider.requests).toHaveLength(1);
  expect(runtime.events(taskId).some(event => event.type === 'context.rejected')).toBe(true);
  await expect(runtime.user.task(taskId).view()).resolves.toMatchObject({
    questions: expect.arrayContaining([expect.objectContaining({ nodeId: 'rejected', kind: 'context_rejected' })]),
  });
});
