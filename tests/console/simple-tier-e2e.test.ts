// Main derives a native graph, receives structured results, and explicitly ends its service lifecycle.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { canonicalJson } from '../../src/core/store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

/** A valid user-defined findings payload, the structured result the tier promises. */
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

  const findings = handoff('调研一个问题', 'SIMPLE_TIER_FINDINGS');
  const result = handoff('汇总调研', 'SIMPLE_TIER_SYNTHESIS');
  const reply = (value: ReturnType<typeof handoff>) => ({ tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value } } }) }] });
  const provider = await openaiServer([reply(findings), { text: 'Research finished.' }, reply(result), { text: 'Synthesis finished.' }]);
  cleanup.push(() => provider.close());

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
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

  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: 'simple tier', requestId: 'begin' });
  const main = runtime.supervisor(ownerId);
  const node = (task: string) => ({ recipe: 'coder@1', model: 'local', task, inputs: { job: { protocol: 'handoff' } }, outputs: { result: { protocol: 'handoff' } }, submission: { required: ['result'] } });
  const created = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'simple tier',
    protocols: { handoff: { type: 'object', required: ['objective', 'workSummary', 'outcome'], properties: { objective: { type: 'string' }, workSummary: { type: 'string' }, outcome: { type: 'string' } } } },
    nodes: { research: node('调研一个自包含问题'), next: node('汇总输入的结构化调研结果') },
    modules: {}, edges: { findings: { from: 'research.result', to: 'next.job', enabled: true } },
    outputs: { result: { from: 'next.result', protocol: 'handoff' } },
  }) }) as { graphId: string };
  const graphId = created.graphId;
  expect(provider.requests).toEqual([]);
  await main.graphSend({ graphId, nodeId: 'research', input: 'job', value: handoff('调研一个问题', 'Start research.') });
  await runtime.host.drive();
  const firstRequest = provider.requests[0] as { tools?: { function: { name: string } }[] };
  const researchTools = firstRequest.tools!.map(tool => tool.function.name);
  expect(researchTools).toContain('submit');
  expect(researchTools).not.toContain('propose_graph');
  expect(researchTools).not.toContain('artifact_promote');
  const downstream = await runtime.nodeRun(graphId, 'next');
  expect(downstream.entries[0]?.text).toContain(canonicalJson(findings));
  expect(JSON.stringify(provider.requests[2])).toContain('SIMPLE_TIER_FINDINGS');
  for (const id of ['research', 'next']) {
    const run = await runtime.nodeRun(graphId, id);
    expect(run.node.status).toBe('succeeded');
    expect(run.operations).toHaveLength(1);
  }
  expect(provider.requests).toHaveLength(4);
  expect(await main.graphInspect({ graphId, query: 'queue' })).toMatchObject({ items: [{ nodeId: 'research', state: 'done' }, { nodeId: 'next', state: 'done' }] });
  expect(await main.graphInspect({ graphId, query: 'results' })).toMatchObject([{ value: result }]);
  expect((await runtime.user.task(graphId).view()).phase).not.toBe('completed');
  await main.graphControl({ graphId, action: 'complete' });
  await runtime.host.drive();
  expect((await runtime.user.task(graphId).view()).phase).toBe('completed');
  expect((await runtime.user.task(ownerId).view()).phase).toBe('discussing');
  await expect(main.graphSend({ graphId, nodeId: 'research', input: 'job', value: findings })).rejects.toMatchObject({ code: 'completing' });
  expect(provider.requests).toHaveLength(4);
}, 120_000);
