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
  contextView,
  digest,
  freezeContextHandoff,
  recordContextSession,
  resolveAgentContext,
} from '../../src/core/context.ts';
import { loadGraph } from '../../src/core/graph.ts';
import { buildPredecessorHandoffs, renderPredecessorHandoffs } from '../../src/core/predecessor-handoff.ts';
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

test('predecessor handoff policies are frozen at graph definition and enforce review isolation', () => {
  expect(() => validateProposal({
    requirementVersion: 1,
    summary: 'review cannot consume a result handoff',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'review',
        dependsOn: ['work'],
        context: {
          purpose: 'review',
          independence: 'model-excluded',
          predecessors: [{ source: 'work', mode: 'result_handoff' }],
        },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['review'] },
    ],
  })).toThrow(/require evidence_only/);

  expect(() => validateProposal({
    requirementVersion: 1,
    summary: 'program nodes cannot author result handoffs',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'probe', kind: 'program', action: 'check' },
      {
        id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local',
        dependsOn: ['probe'],
        context: { predecessors: [{ source: 'probe', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  })).toThrow(/must contain only Agent nodes/);
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
  expect(source.context?.modelPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(source.context?.toolPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(fork.context?.modelPolicyDigest).toBe(source.context?.modelPolicyDigest);
  expect(fork.context?.toolPolicyDigest).toBe(source.context?.toolPolicyDigest);
  expect(fork.context?.constraintsDigest).toBe(source.context?.constraintsDigest);

  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const scopes = store.db.prepare(`SELECT id,limit_tokens,unlimited,used_tokens FROM budget_scopes
    WHERE id IN (?,?) ORDER BY id`).all(source.context!.budgetScope!.id, fork.context!.budgetScope!.id) as { id: string }[];
  expect(scopes).toHaveLength(1);
  expect(fork.context?.budgetScope?.id).toBe(source.context?.budgetScope?.id);

  const forkRequest = provider.requests.find(request => JSON.stringify(request).includes('SOURCE_TRANSCRIPT_SENTINEL'));
  expect(forkRequest).toBeTruthy();
}, 120_000);

test('a result_handoff edge injects the predecessor work summary into the next Fresh Agent', async () => {
  const resultHandoff = {
    schemaVersion: 1,
    objective: 'Complete the first implementation step',
    outcome: 'completed',
    workSummary: 'WORK_SUMMARY_SENTINEL: implemented the parser and left the integration point ready.',
    changes: [],
    decisions: [{ decision: 'Keep the parser pure', rationale: 'The next step needs deterministic tests.', evidenceRefs: [] }],
    verification: [{ summary: 'Focused parser checks passed', result: 'pass', evidenceRefs: [] }],
    knownLimits: [],
    openQuestions: [],
    nextActions: ['Wire the parser into the command'],
  };
  const provider = await openaiServer([
    { tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: JSON.stringify(resultHandoff) }) }] },
    { text: 'SOURCE_DONE' },
    { text: 'NEXT_DONE' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-result-handoff-'));
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
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'result handoff pipeline', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Carry the first implementation result into the next Fresh Agent.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'],
        context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const next = runtime.nodeRun(taskId, 'next');
  expect(next.context).toMatchObject({
    selectedMode: 'fresh',
    predecessorPolicies: [{ source: 'work', mode: 'result_handoff' }],
  });
  expect(next.context?.predecessorHandoffs).toEqual([
    expect.objectContaining({
      sourceNodeId: 'work',
      mode: 'result_handoff',
      resultHandoff: expect.objectContaining({ workSummary: resultHandoff.workSummary }),
    }),
  ]);
  expect(JSON.stringify(provider.requests[2])).toContain('WORK_SUMMARY_SENTINEL');

  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const stored = store.db.prepare("SELECT schema_kind,schema_version,digest FROM result_handoffs WHERE node_id='work'").get() as {
    schema_kind: string;
    schema_version: number;
    digest: string;
  };
  expect(stored).toMatchObject({ schema_kind: 'result_handoff', schema_version: 1 });
  expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
}, 120_000);

test('an evidence_only edge hides a predecessor result handoff from the Fresh Agent projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-evidence-only-handoff-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const workSpec = { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local' };
  const nextSpec = {
    id: 'review', kind: 'agent' as const, action: 'review', definitionVersion: 'reviewer@1', model: 'review', dependsOn: ['work'],
    context: { purpose: 'review' as const, independence: 'model-excluded' as const, predecessors: [{ source: 'work', mode: 'evidence_only' as const }] },
  };
  const result = {
    outcome: 'completed' as const,
    output: { text: 'WORK_RESULT_SENTINEL' },
    artifacts: [],
  };
  const handoff = {
    schemaVersion: 1 as const,
    objective: 'Inspect the implementation',
    outcome: 'completed' as const,
    workSummary: 'HANDOFF_SUMMARY_SENTINEL: implementation finished.',
    changes: [],
    decisions: [],
    verification: [],
    knownLimits: [],
    openQuestions: [],
    nextActions: [],
    source: {
      nodeId: 'work', instanceId: 'i-work', operationId: 'op-work', activationId: 'a-work', outputVersion: 1,
      operationResultDigest: digest(result),
    },
  };
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq,graph_version) VALUES('t','p','evidence only','running',1,1)").run();
    store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id,status,output,output_version,activation_id) VALUES(?,?,?,?,?,?,?,?)')
      .run('t', 'work', canonicalJson(workSpec), 'i-work', 'succeeded', canonicalJson(result.output), 1, 'a-work');
    store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id,status,activation_id) VALUES(?,?,?,?,?,?)')
      .run('t', 'review', canonicalJson(nextSpec), 'i-review', 'pending', 'a-review');
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-work','t','work',100,0,0)").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-review','t','review',100,0,0)").run();
    store.db.prepare(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id,result)
      VALUES('op-work','t','work','i-work',1,?,'succeeded',0,'a-work',?)`)
      .run(canonicalJson({ ...workSpec, taskId: 't', id: 'op-work', generation: 1, attempt: 1 }), canonicalJson(result));
    store.db.prepare("UPDATE nodes SET output_operation='op-work' WHERE task_id='t' AND id='work'").run();
    store.db.prepare(`INSERT INTO graph_revisions(task_id,version,spec,reason,base_version)
      VALUES('t',1,?,'test',0)`).run(canonicalJson({
        requirementVersion: 1,
        summary: 'evidence only',
        acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
        nodes: [workSpec, nextSpec, { id: 'check', kind: 'program', action: 'check', dependsOn: ['review'] }],
      }));
    store.db.prepare(`INSERT INTO result_handoffs(id,task_id,node_id,instance_id,operation_id,activation_id,output_version,
      schema_kind,schema_version,body,digest,created_at) VALUES('rh','t','work','i-work','op-work','a-work',1,'result_handoff',1,?,?,0)`)
      .run(canonicalJson(handoff), digest(handoff));
  });

  const projected = buildPredecessorHandoffs(store, loadGraph(store, 't'), nextSpec);
  expect(projected.projections).toEqual([
    expect.objectContaining({ sourceNodeId: 'work', mode: 'evidence_only' }),
  ]);
  expect(projected.projections[0]?.resultHandoff).toBeUndefined();
  expect(renderPredecessorHandoffs(projected.projections)).not.toContain('HANDOFF_SUMMARY_SENTINEL');

  store.db.prepare("UPDATE operations SET result=? WHERE id='op-work'").run(canonicalJson({
    ...result,
    output: { text: 'TAMPERED_OPERATION_RESULT' },
  }));
  expect(() => buildPredecessorHandoffs(store, loadGraph(store, 't'), {
    ...nextSpec,
    context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
  })).toThrow(/operation result mismatch/);
});

test('a required result_handoff fails closed before the downstream Fresh Agent is dispatched', async () => {
  const provider = await openaiServer([{ text: 'NO_RESULT_HANDOFF' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-missing-result-handoff-'));
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
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'missing handoff', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Reject a pipeline whose predecessor omits its result handoff.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'],
        context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(provider.requests).toHaveLength(1);
  expect(runtime.events(taskId).some(event => event.type === 'context.result_handoff_frozen')).toBe(false);
  await expect(runtime.user.task(taskId).view()).resolves.toMatchObject({
    questions: expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'work',
        kind: 'execution_failed',
        data: expect.objectContaining({
          output: expect.objectContaining({ error: expect.objectContaining({ code: 'result_handoff_invalid' }) }),
        }),
      }),
    ]),
  });
}, 120_000);

test('a fork fails closed when the source policy digest no longer matches', async () => {
  const provider = await openaiServer([{ text: 'SOURCE_POLICY_SENTINEL' }]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-context-policy-digest-'));
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
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'policy mismatch', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Reject a fork whose source policy changed.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'explore', kind: 'agent', action: 'explore', definitionVersion: 'coder@1', model: 'local',
        dependsOn: ['work'],
        context: { purpose: 'explore', sourceNode: 'work', requiredFacts: [{ kind: 'transcript_range' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work', 'explore'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.runReady();

  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  store.db.prepare("UPDATE agent_context_bindings SET model_policy_digest=? WHERE node_id='work'").run('0'.repeat(64));
  store.close();
  await runtime.host.drive();

  expect(provider.requests).toHaveLength(1);
  expect(runtime.events(taskId).some(event => event.type === 'context.rejected')).toBe(true);
  await expect(runtime.user.task(taskId).view()).resolves.toMatchObject({
    questions: expect.arrayContaining([expect.objectContaining({ nodeId: 'explore', kind: 'context_rejected' })]),
  });
}, 120_000);

test('context policy gates recursive forks, incomplete handoffs and independent review sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-context-policy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq) VALUES('t','p','policy',1)").run();
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id,status) VALUES('t','source',?,'i-source','succeeded')")
      .run(canonicalJson({ id: 'source', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' }));
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','child',?,'i-child')")
      .run(canonicalJson({ id: 'child', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' }));
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,instance_id) VALUES('t','review',?,'i-review')")
      .run(canonicalJson({ id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'review' }));
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-source','t','source',100,0,0)").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-child','t','child',100,0,0)").run();
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i-review','t','review',100,0,0)").run();
    store.db.prepare("INSERT INTO budget_scopes(id,task_id,root_task_id,owner_instance_id,limit_tokens,unlimited,used_tokens,created_at) VALUES('scope','t','t','i-source',100,0,0,0)").run();
    store.db.prepare("UPDATE instances SET budget_scope_id='scope' WHERE id IN ('i-source','i-child','i-review')").run();
    store.db.prepare("INSERT INTO node_sessions(instance_id,session_id,session_file,updated_at) VALUES('i-source','s-source','/tmp/source.jsonl',0)").run();
    store.db.prepare("INSERT INTO node_sessions(instance_id,session_id,session_file,updated_at) VALUES('i-review','s-review','/tmp/review.jsonl',0)").run();
    store.db.prepare(`INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,source_instance_id,budget_scope_id,created_at)
      VALUES('binding-source','t','source','i-source','fork',NULL,'scope',0)`).run();
  });

  expect(() => resolveAgentContext(store, {
    taskId: 't',
    nodeId: 'child',
    spec: {
      id: 'child', kind: 'agent', action: 'explore', definitionVersion: 'coder@1', model: 'local',
      context: { purpose: 'explore', sourceNode: 'source', requiredFacts: [{ kind: 'transcript_range' }] },
    },
    review: false,
  })).toThrow(/recursive fork/);

  const review = resolveAgentContext(store, {
    taskId: 't',
    nodeId: 'review',
    spec: { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'review', context: { purpose: 'review', independence: 'model-excluded' } },
    review: true,
    excludedModels: ['b', 'a', 'a'],
  });
  expect(review).toMatchObject({
    mode: 'fresh',
    reviewPolicy: { freshRequired: true, evidenceOnly: true, excludedModels: ['a', 'b'] },
  });

  const gate = resolveAgentContext(store, {
    taskId: 't',
    nodeId: 'child',
    spec: { id: 'child', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
    review: false,
  });
  expect(() => freezeContextHandoff(store, gate, {
    taskId: 't', operationId: 'op-missing', nodeId: 'child', instanceId: 'i-child',
    package: {
      mode: gate.mode, purpose: gate.purpose, independence: gate.independence,
      requestedFacts: gate.requestedFacts, reasonCode: gate.reasonCode,
      sourceNodeId: null, sourceInstanceId: null, sourceSessionId: null, sourceLeafId: null,
      summary: 'incomplete', decisions: [], acceptance: [], artifactRefs: [],
      predecessorPolicies: [], predecessorHandoffs: [],
      outputSchema: { kind: 'agent_result', version: 1 }, briefing: 'incomplete',
    },
  })).toThrow(/acceptance contract/);
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
    taskId: 't', operationId: 'op-continued', nodeId: 'continued', instanceId: 'i-continued',
    package: {
      mode: continued.mode, purpose: continued.purpose, independence: continued.independence,
      requestedFacts: continued.requestedFacts, reasonCode: continued.reasonCode,
      sourceNodeId: null, sourceInstanceId: null, sourceSessionId: null, sourceLeafId: null,
      summary: '继续', decisions: [], acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
      artifactRefs: [], predecessorPolicies: [], predecessorHandoffs: [],
      outputSchema: { kind: 'agent_result', version: 1 }, briefing: '继续',
    },
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
    taskId: 't', operationId: 'op-fresh', nodeId: 'fresh', instanceId: 'i-fresh',
    package: {
      mode: fresh.mode, purpose: fresh.purpose, independence: fresh.independence,
      requestedFacts: fresh.requestedFacts, reasonCode: fresh.reasonCode,
      sourceNodeId: null, sourceInstanceId: null, sourceSessionId: null, sourceLeafId: null,
      summary: '全新', decisions: [], acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
      artifactRefs: [], predecessorPolicies: [], predecessorHandoffs: [],
      outputSchema: { kind: 'agent_result', version: 1 }, briefing: '全新',
    },
  });
  recordContextSession(store, {
    taskId: 't', nodeId: 'fresh', operationId: 'op-fresh', bindingId: fresh.bindingId,
    sessionId: 's-fresh', childContextDigest: 'e'.repeat(64),
  });

  const branchEvents = store.db.prepare("SELECT type,json_extract(data,'$.nodeId') AS nodeId FROM events WHERE type IN ('context.branch_created','context.branch_resumed') ORDER BY cursor").all() as { type: string; nodeId: string }[];
  expect(branchEvents).toEqual([{ type: 'context.branch_resumed', nodeId: 'continued' }]);
  const versions = store.db.prepare('SELECT version FROM context_handoffs WHERE task_id=? ORDER BY version').all('t') as { version: number }[];
  expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
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
