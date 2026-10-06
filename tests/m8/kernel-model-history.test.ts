import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { ModelEntry } from '../../src/catalog/models.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// Complements the cycle/alias selector test: real host wiring must pass immutable
// history into selection and park missing candidates without spending model calls.
test('native review uses an independent provider model and a missing candidate blocks only its own queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-model-history-'));
  const worker = await openaiServer([{ text: 'implementation' }, { text: 'independent branch continues' }]);
  const reviewer = await openaiServer([{ text: 'independent review' }]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
    const entry = (id: string, modelId: string, baseUrl: string): ModelEntry => ({ id, modelId,
      provider: worker.model.provider, grade: 'medium', api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 256 });
    const entries = [entry('worker', 'same-model', worker.model.baseUrl), entry('alias', 'same-model', worker.model.baseUrl),
      entry('reviewer', 'different-model', reviewer.model.baseUrl)];
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
      catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') }, limits: { defaultBudgetTokens: 20000000 },
      models: { entries, apiKey: 'local-fixture', modelRuntime: worker.runtime },
    });
    for (const [id, review] of [['implementer', false], ['review', true]] as const) {
      await runtime.catalog.saveAgentCombination({ id, name: id, description: id, recommendedGrade: 'medium', review,
        tags: [], resources: [], systemPrompt: review ? 'Review independently.' : 'Implement the assignment.' });
    }
    const parent = await runtime.user.begin({ projectId: 'p', request: 'review independence', requestId: 'parent' });
    const main = runtime.supervisor(parent.taskId);
    const created = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'review',
      protocols: { data: { type: 'object' } }, nodes: {
        work: { recipe: 'implementer@1', task: 'implement', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: {} },
        review: { recipe: 'review@1', task: 'review implementation', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
      }, modules: {}, edges: { review: { from: 'work.result', to: 'review.job', enabled: true } },
    }) }) as { graphId: string };
    const graphId = created.graphId;
    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
    await runtime.host.drive();
    // Hot edits cannot rewrite the identity already sent by the implementer.
    entries[0]!.modelId = 'edited-model';
    await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} });
    await runtime.host.drive();
    expect(reviewer.requests).toHaveLength(1);
    expect(worker.requests).toHaveLength(1);
    const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { nodeId: string; model: { id: string; identity: string } }[];
    expect(calls.map(call => ({ nodeId: call.nodeId, model: call.model.id, identity: call.model.identity }))).toEqual([
      { nodeId: 'work', model: 'worker', identity: 'same-model' },
      { nodeId: 'review', model: 'reviewer', identity: 'different-model' },
    ]);
    entries.pop();
    await main.graphSend({ graphId, nodeId: 'review', text: 'review again' });
    await main.graphSend({ graphId, nodeId: 'work', text: 'continue independent work' });
    await runtime.host.drive();
    expect(runtime.nodeRun(graphId, 'review').node.status).toBe('blocked');
    expect(runtime.nodeRun(graphId, 'work').entries.some(entry => entry.text.includes('independent branch continues'))).toBe(true);
    expect(reviewer.requests).toHaveLength(1);
    expect(worker.requests).toHaveLength(2);
  } finally {
    await runtime?.close();
    await reviewer.close(); await worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
