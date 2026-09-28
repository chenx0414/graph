// A chain of derived agents must drain at any depth.
//
// This began as HB-187, filed as "a chain of depth >= 3 blocks its second node". That was wrong:
// the blocked node was an artifact of the test fixture, which answered EVERY model turn with a
// tool call. A real Agent submits its result and then stops talking, but the fixture kept handing
// it another tool call, so the first node looped until the scripted replies ran out and the nodes
// behind it never got one. With a truthful fixture (submit, then plain text) the chain drains at
// depth 2 and 3 alike, so what this test protects is depth-independence, not a defect.
//
// It runs against a real local model server, through the production create -> propose -> accept ->
// dispatch -> settle path.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

function handoff(summary: string) {
  return {
    schemaVersion: 1 as const,
    objective: 'step',
    outcome: 'completed' as const,
    workSummary: summary,
    changes: [],
    decisions: [],
    verification: [],
    knownLimits: [],
    openQuestions: [],
    nextActions: [],
  };
}

/**
 * A truthful agent turn: submit the structured result once, then answer with plain text so the turn
 * ends. Alternating matters -- a fixture that only ever returns a tool call makes the Agent call it
 * forever, which is a property of the fixture, not of the runtime.
 */
function agentTurns(count: number) {
  const submit = { tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: JSON.stringify(handoff('step done')) }) }] };
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? submit : { text: 'step done' }));
}

async function runChain(links: number) {
  const root = await mkdtemp(join(tmpdir(), `graph-chain-${links}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });

  const provider = await openaiServer(agentTurns(links * 6));
  cleanup.push(() => provider.close());

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed', output: null,
          evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
        }),
      },
    },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'k', modelRuntime: provider.runtime,
    },
  });
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);

  const ids = Array.from({ length: links }, (_, index) => `n${index}`);
  const nodes = ids.map((id, index) => index === 0
    ? { id, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local' }
    : {
        id, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local',
        dependsOn: [ids[index - 1]!],
        context: { purpose: 'implement' as const, predecessors: [{ source: ids[index - 1]!, mode: 'result_handoff' as const }] },
      });

  const { taskId } = await runtime.user.begin({ projectId: 'p', request: `chain of ${links}`, requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1,
    summary: `chain of ${links}`,
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [...nodes, { id: 'check', kind: 'program', action: 'check', dependsOn: [ids[ids.length - 1]!] }],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const view = await runtime.user.task(taskId).view();
  return {
    statuses: Object.fromEntries(view.nodes.map(node => [node.id, node.status])) as Record<string, string>,
    openProblems: (view.questions ?? []).length,
  };
}

test('a two-link chain drains completely', async () => {
  const { statuses, openProblems } = await runChain(2);
  expect(openProblems).toBe(0);
  expect(statuses).toEqual({ n0: 'succeeded', n1: 'succeeded', check: 'succeeded' });
}, 120_000);

test('a three-link chain drains completely', async () => {
  const { statuses, openProblems } = await runChain(3);
  expect(openProblems).toBe(0);
  expect(statuses).toEqual({ n0: 'succeeded', n1: 'succeeded', n2: 'succeeded', check: 'succeeded' });
}, 120_000);
