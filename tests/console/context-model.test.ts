import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
import {
  buildPredecessorHandoffs,
  inspectResultHandoffSubmission,
  recoverResultHandoffDraft,
  renderPredecessorHandoffs,
  resultHandoffFailure,
  settleResultHandoff,
} from '../../src/core/predecessor-handoff.ts';
import type { NodeSpec, Operation, Proposal } from '../../src/core/types.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

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

  expect(() => validateProposal({
    requirementVersion: 1,
    summary: 'verification result can hand off to rework',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      {
        id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'review',
        context: { purpose: 'review', independence: 'model-excluded' },
      },
      {
        id: 'rework', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local',
        dependsOn: ['review'],
        context: { purpose: 'rework', predecessors: [{ source: 'review', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['rework'] },
    ],
  })).not.toThrow();

  expect(() => validateProposal({
    requirementVersion: 1,
    summary: 'ambiguous incoming edges require a policy',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'absorb', kind: 'agent', action: 'absorb', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'] },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['absorb'] },
    ],
  })).toThrow(/requires an explicit handoff policy/);
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
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
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
  } as Proposal), 'proposal');
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
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1,
    summary: 'Carry the first implementation result into the next Fresh Agent.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'],
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  } as Proposal), 'proposal');
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
  expect(runtime.events(taskId).some(event => event.type === 'context.handoff_policy_selected')).toBe(true);
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
    context: { purpose: 'review' as const, independence: 'model-excluded' as const },
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
    // Written by the harness's own writer, not hand-rolled: a row this test composed itself would
    // carry a fingerprint computed differently from the one the reader compares against, and the
    // assertion below would then hold whether or not anything was tampered with.
    settleResultHandoff(
      store,
      { id: 'op-work', taskId: 't', nodeId: 'work', instanceId: 'i-work', activationId: 'a-work', workspace: root } as Operation,
      {
        requirementVersion: 1,
        summary: 'evidence only',
        acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
        nodes: [
          workSpec,
          { ...nextSpec, context: { purpose: 'implement' as const, predecessors: [{ source: 'work', mode: 'result_handoff' as const }] } },
          { id: 'check', kind: 'program' as const, action: 'check', dependsOn: ['review'] },
        ],
      } as Proposal,
      { ...result, resultHandoff: handoff },
    );
    // The real settle bumps the node's output version after the handoff is written, and the reader
    // looks the row up under that version; a fixture that skips the bump would look under the old one.
    store.db.prepare("UPDATE nodes SET output_version=output_version+1 WHERE task_id='t' AND id='work'").run();
  });
  expect(store.db.prepare("SELECT count(*) AS n FROM result_handoffs WHERE node_id='work'").get()).toMatchObject({ n: 1 });

  const projected = buildPredecessorHandoffs(store, loadGraph(store, 't'), nextSpec);
  expect(projected.projections).toEqual([
    expect.objectContaining({ sourceNodeId: 'work', mode: 'evidence_only' }),
  ]);
  expect(projected.projections[0]?.resultHandoff).toBeUndefined();
  expect(renderPredecessorHandoffs(projected.projections)).not.toContain('HANDOFF_SUMMARY_SENTINEL');

  // The same row IS readable when the edge asks for it - the fingerprint matches the result the
  // store holds. Without this half the assertion below could pass because nothing ever matched.
  const asResultHandoff = () => buildPredecessorHandoffs(store, loadGraph(store, 't'), {
    ...nextSpec,
    context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
  });
  expect(asResultHandoff().projections[0]?.resultHandoff?.workSummary).toContain('HANDOFF_SUMMARY_SENTINEL');

  store.db.prepare("UPDATE operations SET result=? WHERE id='op-work'").run(canonicalJson({
    ...result,
    output: { text: 'TAMPERED_OPERATION_RESULT' },
  }));
  expect(() => asResultHandoff()).toThrow(/operation result mismatch/);
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
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
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
  } as Proposal), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(provider.requests).toHaveLength(1);
  const events = runtime.events(taskId);
  expect(events.some(event => event.type === 'context.result_handoff_frozen')).toBe(false);
  // One problem for whoever owns execution, not one failure plus one rejection
  // per dependent: the downstream node simply never becomes ready.
  expect(events.some(event => event.type === 'context.result_noncompliant'
    && (event.data as { nodeId?: string }).nodeId === 'work')).toBe(true);
  await expect(runtime.user.task(taskId).view()).resolves.toMatchObject({
    questions: [
      expect.objectContaining({
        nodeId: 'work',
        kind: 'result_noncompliant',
        data: expect.objectContaining({
          reason: expect.stringContaining('result_handoff@1'),
          defects: expect.arrayContaining([expect.objectContaining({ path: 'objective', class: 'semantic' })]),
          sourceNodeId: 'work',
          policy: 'result_handoff',
          resume: ['next'],
        }),
      }),
    ],
  });
}, 120_000);

test('a handoff that names a shared artifact by its logical key is bound to the recorded version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-rebind-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const workSpec: NodeSpec = { id: 'work', kind: 'agent', action: 'work' };
  const nextSpec: NodeSpec = {
    id: 'next', kind: 'agent', action: 'work', dependsOn: ['work'],
    context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
  };
  const artifactDigest = createHash('sha256').update('ARTIFACT_BODY').digest('hex');
  store.transaction(() => {
    store.db.prepare('INSERT INTO projects(id,root,grants) VALUES(?,?,?)').run('p', root, '[]');
    store.db.prepare("INSERT INTO tasks(id,project_id,request,phase,created_seq,graph_version) VALUES('t','p','artifact handoff','running',1,1)").run();
    store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id,status,output_version,activation_id) VALUES(?,?,?,?,?,?,?)')
      .run('t', 'work', canonicalJson(workSpec), 'i', 'running', 0, 'a');
    store.db.prepare("INSERT INTO instances(id,task_id,node_id,budget,used,unlimited) VALUES('i','t','work',100,0,0)").run();
    store.db.prepare(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,activation_id)
      VALUES('op','t','work','i',1,?,'running',0,'a')`)
      .run(canonicalJson({ ...workSpec, taskId: 't', id: 'op', generation: 1, attempt: 1 }));
    store.db.prepare(`INSERT INTO artifacts(artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,
      digest,object_path,size,media_type,visibility,trust,state,created_at)
      VALUES('art-1',1,'task','t','t','p','summaries','report','summaries/report',?,?,10,'text/plain','task','unverified','published',0)`)
      .run(artifactDigest, join(root, 'object'));
  });
  const proposal: Proposal = {
    requirementVersion: 1,
    summary: 'artifact handoff',
    acceptance: [],
    nodes: [workSpec, nextSpec],
  };
  const operation: Operation = {
    id: 'op', taskId: 't', nodeId: 'work', instanceId: 'i', generation: 1, attempt: 1,
    kind: 'agent', action: 'work', input: null, dependencies: {},
    proposalVersion: 1, requirementVersion: 1,
    context: { previousOutput: null, answers: [] },
    grants: [], activationId: 'a', graphVersion: 1, dependencySources: {}, inputVersions: {},
  };
  const settled = settleResultHandoff(store, operation, proposal, {
    outcome: 'completed',
    output: {
      schemaVersion: 1,
      objective: 'Publish the shared report',
      outcome: 'completed',
      workSummary: 'REPORT_SUMMARY_SENTINEL',
      // The worker wrote the logical key and the version as a string; the
      // recorded artifact is the only source of truth for both.
      changes: [{
        kind: 'artifact',
        artifactId: 'summaries/report',
        version: '1',
        uri: 'graph://tasks/t/artifacts/summaries/report@1',
        summary: 'Shared report',
      }],
      decisions: [], verification: [], knownLimits: [], openQuestions: [], nextActions: [],
    },
  });
  expect(resultHandoffFailure(settled)).toBeUndefined();
  const frozen = store.db.prepare("SELECT body FROM result_handoffs WHERE node_id='work'").get() as { body: string };
  expect(JSON.parse(frozen.body).changes).toEqual([
    expect.objectContaining({ artifactId: 'art-1', version: 1, digest: artifactDigest }),
  ]);
});

test('the host supplies the digest and absolute path a worker left out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-digest-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'page.html'), 'PAGE_BODY');
  const inspected = inspectResultHandoffSubmission({
    schemaVersion: 1,
    objective: 'Ship the page',
    outcome: 'completed',
    workSummary: 'Wrote the page',
    // The worker names the file it wrote and nothing else.
    changes: [{ kind: 'file', path: 'page.html', summary: 'Landing page' }],
    decisions: [], verification: [], knownLimits: [], openQuestions: [], nextActions: [],
  }, { workspace });
  expect(inspected.repaired).toBe(true);
  expect(inspected.draft?.changes).toEqual([{
    kind: 'file',
    path: join(workspace, 'page.html'),
    digest: createHash('sha256').update('PAGE_BODY').digest('hex'),
    summary: 'Landing page',
  }]);
});

test('handoff repair never resolves a file change outside the worker work copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-traversal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work');
  await mkdir(join(root, 'secrets'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const digest = createHash('sha256').update('classified\n').digest('hex');
  const submission = {
    schemaVersion: 1,
    objective: 'Exfiltrate a host file',
    outcome: 'completed',
    workSummary: 'TRAVERSAL_SENTINEL',
    changes: [{ kind: 'file', path: '../secrets/token.txt', digest, summary: 'Outside the work copy' }],
    decisions: [],
    verification: [],
    knownLimits: [],
    openQuestions: [],
    nextActions: [],
  };
  expect(recoverResultHandoffDraft(submission, { workspace })).toBeUndefined();
});

test('workspace-relative file changes in a result_handoff are resolved and verified instead of rejected', async () => {
  const landing = '<!doctype html><title>Landing</title>\n';
  const handoff = {
    schemaVersion: 1,
    objective: 'Ship the landing page',
    outcome: 'completed',
    workSummary: 'WROTE_LANDING_PAGE_SENTINEL',
    changes: [{
      kind: 'file',
      path: 'index.html',
      digest: createHash('sha256').update(landing).digest('hex'),
      summary: 'Static landing page',
    }],
    decisions: [],
    verification: [],
    knownLimits: [],
    openQuestions: [],
    nextActions: [],
  };
  const root = await mkdtemp(join(tmpdir(), 'graph-relative-handoff-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  // The worker writes its deliverable into its private work copy, then submits a
  // handoff that names the file the way it saw it: workspace-relative.
  const writeDeliverable = async () => {
    const [taskDir] = await readdir(join(root, 'state', 'worktrees'));
    const entries = await readdir(join(root, 'state', 'worktrees', taskDir!));
    for (const entry of entries.filter(candidate => candidate !== 'integration')) {
      await writeFile(join(root, 'state', 'worktrees', taskDir!, entry, 'index.html'), landing);
    }
  };
  const provider = await openaiServer([
    {
      beforeReply: writeDeliverable,
      tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: JSON.stringify(handoff) }) }],
    },
    { text: 'SOURCE_DONE' },
    { text: 'DOWNSTREAM_DONE' },
  ]);
  cleanup.push(() => provider.close());
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
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'relative handoff', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1,
    summary: 'A worker may name its own work copy files with workspace-relative paths.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'],
        context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  } as Proposal), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const events = runtime.events(taskId);
  expect(events.find(event => event.type === 'context.result_handoff_missing')).toBeUndefined();
  expect(events.some(event => event.type === 'context.result_handoff_frozen')).toBe(true);
  // The file only ever existed in the worker's work copy, never in the project.
  await expect(readdir(workspace)).resolves.toEqual(['.git']);
  expect(runtime.nodeRun(taskId, 'next').context?.predecessorHandoffs).toEqual([
    expect.objectContaining({
      sourceNodeId: 'work',
      mode: 'result_handoff',
      resultHandoff: expect.objectContaining({
        workSummary: 'WROTE_LANDING_PAGE_SENTINEL',
        changes: [expect.objectContaining({ path: expect.stringMatching(/index\.html$/) })],
      }),
    }),
  ]);
  expect(provider.requests).toHaveLength(3);
  expect(JSON.stringify(provider.requests[2])).toContain('WROTE_LANDING_PAGE_SENTINEL');
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
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
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
  } as Proposal), 'proposal');
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
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
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
  } as Proposal), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(provider.requests).toHaveLength(1);
  expect(runtime.events(taskId).some(event => event.type === 'context.rejected')).toBe(true);
  await expect(runtime.user.task(taskId).view()).resolves.toMatchObject({
    questions: expect.arrayContaining([expect.objectContaining({ nodeId: 'rejected', kind: 'context_rejected' })]),
  });
});
