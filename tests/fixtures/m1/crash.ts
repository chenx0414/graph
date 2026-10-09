// A real runtime/worker is killed by the parent after observing a public send
// boundary. No operation rows, provider receipts or node state are fabricated.
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../../src/core/interface-spec.ts';
import { fullAccessPolicy } from '../../../src/core/access-policy.ts';
import { createModelScheduler } from '../../../src/runtime/model-scheduler.ts';
import { toPiModel } from '../../../src/runtime/pi-adapter.ts';

const [root, stage, baseUrl, access] = process.argv.slice(2) as [string, string, string, string?];
process.on('message', () => {});
const entry = { id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl, contextWindow: 32000, maxTokens: 256 };
const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
models.registerProvider('graph-openai', { baseUrl, api: entry.api, apiKey: 'scripted-local-key', models: [toPiModel(entry)] });
const scheduler = createModelScheduler();
const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
  limits: { defaultBudgetTokens: 20_000_000 }, ...(access === 'full' ? { access: () => fullAccessPolicy() } : {}),
  models: { entries: [entry], modelRuntime: models, modelScheduler: scheduler,
    credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key', limit: 1 }) },
});
runtime.catalog.publishDefinition('worker', { recommendedGrade: 'high' }, 'worker');
const parent = await runtime.user.begin({ projectId: 'project', request: 'Recover this work', requestId: 'begin' });
const main = runtime.supervisor(parent.taskId);
const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Crash recovery', protocols: { data: { type: 'object' } },
  nodes: { work: { recipe: 'worker@1', model: 'local', task: 'Retain the assigned input across restart', inputs: { job: { protocol: 'data' } },
    outputs: { out: { protocol: 'data' } }, submission: { required: ['out'] } } }, modules: {}, edges: {}, outputs: { result: { from: 'work.out', protocol: 'data' } },
}) }) as { graphId: string };
await main.graphSend({ graphId, nodeId: 'work', text: 'Establish the original chat history' });
await runtime.host.drive();
if (stage === 'intent') await scheduler.acquire({ credentialId: 'cred', limit: 1 });
if (stage === 'submitted') await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { text: 'Publish the assigned result' } });
else await main.graphSend({ graphId, nodeId: 'work', text: 'Continue the original assignment' });
void runtime.host.drive().catch(error => { console.error(error); process.exit(1); });
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { id: string; state: string }[];
  const ready = stage === 'intent' ? scheduler.queued() === 1 : calls.at(-1)?.state === 'inflight';
  const results = await main.graphInspect({ graphId, query: 'results' }) as unknown[];
  if (ready && (stage !== 'submitted' || results.length === 1)) {
    const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
    const executions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { id: string }[] };
    process.send?.({ graphId, ownerId: parent.taskId, instanceId: runtime.nodeRun(graphId, 'work').instance!.id,
      seq: queue.items.find(item => item.state === 'claimed')!.seq, executionId: executions.items.at(-1)!.id,
      callId: stage === 'intent' ? null : calls.at(-1)!.id });
    await new Promise(() => {});
  }
  await delay(10);
}
throw new Error('Crash fixture did not reach its requested native boundary');
