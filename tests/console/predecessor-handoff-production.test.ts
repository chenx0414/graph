import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

function handoff(workSummary: string, objective = 'Complete the implementation step') {
  return {
    schemaVersion: 1 as const,
    objective,
    outcome: 'completed' as const,
    workSummary,
    changes: [],
    decisions: [],
    verification: [],
    knownLimits: [],
    openQuestions: [],
    nextActions: [],
  };
}

async function runtimeWithProvider(root: string, provider: Awaited<ReturnType<typeof openaiServer>>) {
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
  return { runtime, workspace };
}

test('a container result_handoff resolves to its leaf provenance for the downstream Fresh Agent', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: JSON.stringify(handoff('CONTAINER_LEAF_SUMMARY')) }) }] },
    { text: 'CONTAINER_SOURCE_DONE' },
    { text: 'CONTAINER_DOWNSTREAM_DONE' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-container-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime } = await runtimeWithProvider(root, provider);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'container handoff', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'A container dependency must project its leaf result handoff.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    containers: [{ id: 'bundle', outputs: ['leaf'] }],
    nodes: [
      { id: 'leaf', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', container: 'bundle' },
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['bundle'],
        context: { purpose: 'implement', predecessors: [{ source: 'bundle', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(runtime.nodeRun(taskId, 'next').context?.predecessorHandoffs).toEqual([
    expect.objectContaining({
      sourceNodeId: 'leaf',
      mode: 'result_handoff',
      resultHandoff: expect.objectContaining({ workSummary: 'CONTAINER_LEAF_SUMMARY' }),
    }),
  ]);
  expect(JSON.stringify(provider.requests[2])).toContain('CONTAINER_LEAF_SUMMARY');
}, 120_000);

test('multiple predecessors can mix result_handoff and evidence_only projections', async () => {
  const provider = await openaiServer([
    { tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: JSON.stringify(handoff('MULTI_WORK_SUMMARY')) }) }] },
    { text: 'MULTI_SOURCE_DONE' },
    { text: 'PROBE_FINAL_TEXT_SENTINEL' },
    { text: 'MULTI_DOWNSTREAM_DONE' },
  ]);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-multi-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { runtime } = await runtimeWithProvider(root, provider);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'mixed predecessors', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Each predecessor edge keeps its own handoff policy.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'probe', kind: 'agent', action: 'audit', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'],
        context: { purpose: 'explore', predecessors: [{ source: 'work', mode: 'evidence_only' }] },
      },
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work', 'probe'],
        context: { purpose: 'implement', predecessors: [
          { source: 'work', mode: 'result_handoff' },
          { source: 'probe', mode: 'evidence_only' },
        ] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(runtime.nodeRun(taskId, 'next').context?.predecessorHandoffs).toEqual([
    expect.objectContaining({ sourceNodeId: 'work', mode: 'result_handoff' }),
    expect.objectContaining({ sourceNodeId: 'probe', mode: 'evidence_only' }),
  ]);
  const projections = (runtime.nodeRun(taskId, 'next').context?.predecessorHandoffs ?? []) as { resultHandoff?: unknown }[];
  expect(projections[0]?.resultHandoff).toBeTruthy();
  expect(projections[1]?.resultHandoff).toBeUndefined();
  expect(JSON.stringify(provider.requests[3])).toContain('MULTI_WORK_SUMMARY');
  expect(JSON.stringify(provider.requests[3])).not.toContain('PROBE_FINAL_TEXT_SENTINEL');
}, 120_000);

test('rework invalidates the old result handoff and injects the new activation version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-rework-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  let workRuns = 0;
  let checkRuns = 0;
  const nextBriefings: string[] = [];
  const usage = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 };
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    actions: {
      work: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async () => async () => {
          workRuns += 1;
          return {
            outcome: 'completed',
            output: { version: workRuns },
            resultHandoff: handoff(`WORK_SUMMARY_V${workRuns}`),
            usage,
          };
        },
      },
      next: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async operation => async () => {
          nextBriefings.push(operation.context.briefing ?? '');
          return { outcome: 'completed', output: { version: workRuns }, usage };
        },
      },
      check: {
        kind: 'program',
        prepare: async () => async () => {
          checkRuns += 1;
          if (checkRuns === 1) {
            return {
              outcome: 'completed',
              output: {
                kind: 'verification',
                outcome: 'rework',
                subjects: [],
                reports: [],
                blockers: [{ id: 'retry', reason: 'The first result needs another pass', evidence: [] }],
              },
            };
          }
          return {
            outcome: 'completed',
            output: { kind: 'verification', outcome: 'pass', subjects: [], reports: [], blockers: [] },
            evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'b'.repeat(64) } }],
          };
        },
      },
    },
  });
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'rework handoff', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: 'Rework must not reuse the previous activation result handoff.',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    loops: [{ from: 'check', to: 'work' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      {
        id: 'next', kind: 'agent', action: 'next', definitionVersion: 'coder@1', model: 'local', dependsOn: ['work'],
        context: { purpose: 'implement', predecessors: [{ source: 'work', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  expect(workRuns).toBe(2);
  expect(checkRuns).toBe(2);
  expect(nextBriefings).toHaveLength(2);
  expect(nextBriefings[0]).toContain('WORK_SUMMARY_V1');
  expect(nextBriefings[1]).toContain('WORK_SUMMARY_V2');
  expect(nextBriefings[1]).not.toContain('WORK_SUMMARY_V1');
  expect(runtime.nodeRun(taskId, 'next').context?.predecessorHandoffs).toEqual([
    expect.objectContaining({
      sourceNodeId: 'work',
      outputVersion: 2,
      resultHandoff: expect.objectContaining({ workSummary: 'WORK_SUMMARY_V2' }),
    }),
  ]);

  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const rows = store.db.prepare("SELECT output_version,body,digest FROM result_handoffs WHERE node_id='work' ORDER BY output_version").all() as {
    output_version: number;
    body: string;
    digest: string;
  }[];
  expect(rows.map(row => row.output_version)).toEqual([1, 2]);
  expect(rows[0]?.digest).not.toBe(rows[1]?.digest);
  expect(rows[0]?.body).toContain('WORK_SUMMARY_V1');
  expect(rows[1]?.body).toContain('WORK_SUMMARY_V2');
}, 120_000);
