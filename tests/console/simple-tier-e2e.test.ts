// A simple-tier graph, end to end (R23).
//
// The tier's contract, from docs/design-graph-examples.md: "a subagent is derived by main, does one
// self-contained job, returns a STRUCTURED result, and its session ends." This proves that whole
// chain against a real model server, through the production create -> propose -> accept -> dispatch
// -> settle path. Nothing about the graph machinery is stubbed; only the model's replies are
// scripted.
//
// It deliberately does NOT include a master node: this is what main would derive, and the handoff
// tests already cover master-driven graphs. That also keeps the fixture free of the master's own
// dispatch loop, so a failure here is a failure of the tier, not of that loop.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { Proposal } from '../../src/core/types.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

/** A valid result_handoff@1, the structured result the tier promises. */
function handoff(objective: string, workSummary: string) {
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

test('simple tier: a derived subagent runs, returns a structured result, and hands it downstream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-simple-tier-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });

  // Every agent reply submits a valid structured result. The reply is deliberately independent of
  // which node asks or how often: an agent that keeps working must still be able to comply, and a
  // retry must not consume a reply meant for a different node.
  const reply = () => ({ tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: JSON.stringify(handoff('调研一个问题', 'SIMPLE_TIER_FINDINGS')) }) }] });
  const provider = await openaiServer([reply(), reply(), reply(), reply()]);
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

  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'simple tier', requestId: 'begin' });
  await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1,
    summary: '派生一个自包含的子任务，拿回结构化结果。',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      // The derived subagent: a plain agent node. Its "role" is a recipe (definition), chosen by
      // main -- not an enum value, and not a new field.
      { id: 'research', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      // A downstream edge consumes the structured result, which is what forces the handoff contract.
      {
        id: 'next', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', dependsOn: ['research'],
        context: { purpose: 'implement', predecessors: [{ source: 'research', mode: 'result_handoff' }] },
      },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['next'] },
    ],
  } as Proposal), 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  // 1. The derived subagent was offered the structured-result tool, and no master-only tool leaked.
  const firstRequest = provider.requests[0] as { tools?: { function: { name: string } }[] } | undefined;
  const researchTools = firstRequest?.tools?.map(tool => tool.function.name) ?? [];
  expect(researchTools).toContain('submit_result');
  expect(researchTools).not.toContain('artifact_promote');

  // 2. Its structured result really reached the downstream node.
  const downstream = runtime.nodeRun(taskId, 'next').context?.predecessorHandoffs;
  expect(downstream).toEqual([
    expect.objectContaining({
      sourceNodeId: 'research',
      mode: 'result_handoff',
      resultHandoff: expect.objectContaining({ workSummary: 'SIMPLE_TIER_FINDINGS' }),
    }),
  ]);

  // 3. Every node finished: the subagent's session ended, and the graph drained in one pass.
  const view = await runtime.user.task(taskId).view();
  const statuses = Object.fromEntries(view.nodes.map(node => [node.id, node.status]));
  expect(statuses['research']).toBe('succeeded');
  expect(statuses['next']).toBe('succeeded');
  expect(statuses['check']).toBe('succeeded');

  // 4. Each agent node dispatched exactly once: two agents, two operations. A re-dispatch would
  //    inflate this, and it is a node fact rather than a reply-count guess.
  const { TaskStore } = await import('../../src/core/store.ts');
  const probe = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  const dispatched = probe.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE task_id=? AND node_id IN ('research','next')").get(taskId) as { n: number };
  probe.close();
  expect(dispatched.n).toBe(2);
}, 120_000);
