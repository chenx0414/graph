import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../../src/core/interface-spec.ts';
import { toPiModel } from '../../../src/runtime/pi-adapter.ts';

const [root, project, workUrl, reviewUrl] = process.argv.slice(2) as string[];
process.on('message', () => {});
const capabilityRoot = join(root!, 'capabilities'); await mkdir(capabilityRoot, { recursive: true });
const entries = [{ id: 'work', modelId: 'implementer', baseUrl: workUrl! }, { id: 'review', modelId: 'independent', baseUrl: reviewUrl! }].map(model => ({
  ...model, provider: 'graph-openai', grade: 'medium' as const, api: 'openai-completions' as const, contextWindow: 32000, maxTokens: 256,
}));
const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
models.registerProvider('graph-openai', { baseUrl: workUrl!, api: 'openai-completions', apiKey: 'local-only', models: entries.map(toPiModel) });
const runtime = await openTaskRuntime({ stateDir: join(root!, 'state'), projects: [{ id: 'p', root: project! }],
  catalog: { capabilityRoot, recipesPath: join(root!, 'recipes.json') }, limits: { defaultBudgetTokens: 20000000 },
  models: { entries, modelRuntime: models, apiKey: 'local-only' },
});
for (const [id, review] of [['coder', false], ['reviewer', true]] as const) await runtime.catalog.saveAgentCombination({ id, name: id, review,
  description: id, recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: review ? 'Read the exact commit and publish its independent review.' : 'Write, commit, then submit the result.' });
await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
const owner = await runtime.user.begin({ projectId: 'p', request: 'Crash after a real Git commit', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
const data = { protocol: 'data' };
const { graphId } = await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'Hard Git recovery', protocols: { data: { type: 'object' } },
  nodes: { work: { recipe: 'coder@1', model: 'work', task: 'Write feature.txt, commit it and submit result', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } },
    review: { recipe: 'reviewer@1', model: 'review', task: 'Read the current feature and publish an exact-commit review', inputs: { job: data }, outputs: {}, submission: {} } },
  modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.cjs'], output: 'result' } } },
  edges: {}, acceptance: [{ id: 'works', description: 'feature contains done', kind: 'check', module: 'check' }, { id: 'review', description: 'Independent exact-commit review', kind: 'review', node: 'review' }],
}) }) as { graphId: string };
await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { request: 'Recover this committed write' } });
void runtime.host.drive().catch(error => { console.error(error); process.exit(1); });
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  const calls = await main.graphInspect({ graphId, query: 'provider_calls', id: 'work' }) as { id: string; state: string }[];
  if (calls.length === 3 && calls[2]!.state === 'inflight') {
    const run = runtime.nodeRun(graphId, 'work');
    process.send?.({ graphId, ownerId: owner.taskId, instanceId: run.instance!.id, sessionId: run.session!.sessionId, executionId: run.operations[0]!.id, callId: calls[2]!.id });
    await new Promise(() => {});
  }
  await delay(10);
}
throw new Error('Native Git worker did not reach its post-commit send boundary');
