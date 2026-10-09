// Direct reviewer routing uses named outputs. The graph owns the connections;
// immutable published reports, actual model history and final acceptance own proof.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
type Step = { passed: boolean; reason: string };
const tool = (name: string, value: () => unknown): ResponsePlan => ({ tools: [{ id: name, name, arguments: () => JSON.stringify(value()) }] });

async function lane(steps: Step[], holdFeedback = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-review-router-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>; let graphId = '';
  const artifact = (namespace: string, version: number) => {
    const item = runtime.artifacts.list(graphId, { namespace, latestOnly: false }).artifacts.find(item => item.version === version)!;
    return { artifactId: item.artifactId, version: item.version, digest: item.digest };
  };
  const worker = await openaiServer(steps.flatMap((_, i) => [
    tool('artifact_publish', () => ({ namespace: 'plans', name: 'candidate', content: `Candidate ${i + 1}`, mediaType: 'text/markdown', requestId: `candidate-${i}` })),
    tool('submit', () => ({ outputs: { result: { enable: true, value: { subject: artifact('plans', i + 1) } } } })),
    { text: `Candidate ${i + 1} submitted` },
  ]));
  const reviewer = await openaiServer(steps.flatMap((step, i) => [
    tool('artifact_read', () => artifact('plans', i + 1)),
    tool('artifact_publish', () => ({ namespace: 'reviews', name: 'verdict', schema: 'graph.review@1', mediaType: 'application/json',
      content: JSON.stringify({ commit: null, ...step, subject: artifact('plans', i + 1) }), requestId: `verdict-${i}` })),
    { ...tool('submit', () => ({ outputs: { [step.passed ? 'approved' : 'rework']: { enable: true,
      value: { ...step, subject: artifact('plans', i + 1), report: artifact('reviews', i + 1) } } } })),
      beforeReply: async () => { if (holdFeedback && !step.passed) await runtime.supervisor(graphId).graphControl({ graphId, action: 'pause', nodeId: 'work' }); } },
    { text: `Review ${i + 1} submitted` },
  ]));
  const downstream = await openaiServer([
    tool('artifact_read', () => artifact('reviews', steps.length)), { text: 'Consumed the exact published review.' },
  ]);
  for (const provider of [worker, reviewer, downstream]) cleanup.push(() => provider.close());
  runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: worker.runtime, entries: ([['work', worker], ['review', reviewer], ['after', downstream]] as const)
      .map(([id, provider]) => ({ id, modelId: `${id}-identity`, provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) },
  }); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  await runtime.catalog.saveAgentCombination({ id: 'reviewer', name: 'Independent reviewer', description: 'Review published candidates',
    recommendedGrade: 'medium', review: true, tags: [], resources: [], systemPrompt: 'Read the immutable candidate and publish your verdict.' });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Direct reviewer routing', requestId: 'begin' });
  const main = runtime.supervisor(owner.taskId); const data = { protocol: 'data' };
  graphId = ((await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Reviewer outputs',
    protocols: { data: { type: 'object' } }, nodes: {
      work: { recipe: 'worker@1', model: 'work', task: 'Publish the candidate and submit its stable reference.', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } },
      review: { recipe: 'reviewer@1', model: 'review', task: 'Read candidate, publish graph.review@1 and submit either approved or rework.',
        inputs: { job: data }, outputs: { approved: data, rework: data }, submission: { requiredAnyOf: ['approved', 'rework'] } },
      after: { recipe: 'worker@1', model: 'after', task: 'Read the exact published review received on the input.', inputs: { job: data }, outputs: {}, submission: {} },
    }, modules: {}, edges: { reviewed: { from: 'work.result', to: 'review.job', enabled: true },
      rework: { from: 'review.rework', to: 'work.job', enabled: true }, approved: { from: 'review.approved', to: 'after.job', enabled: true } },
    outputs: { result: { from: 'review.approved', protocol: 'data' } },
    acceptance: [{ id: 'review', description: 'Independent review of the published candidate', kind: 'review', node: 'review' }],
  }) })) as { graphId: string }).graphId;
  return { runtime, main, graphId, worker, reviewer, downstream, artifact,
    async run() { await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { goal: 'Produce the candidate' } }); await runtime.host.drive(); },
    async complete() { await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); return runtime.user.task(graphId).view(); },
  };
}

test('a reviewer rework output returns to the same worker without a gate module', async () => {
  const graph = await lane([{ passed: false, reason: 'The legend is not persistent' }, { passed: true, reason: 'Fine now' }]);
  const instance = graph.runtime.nodeRun(graph.graphId, 'work').instance!.id; await graph.run();
  const executions = await graph.main.graphInspect({ graphId: graph.graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
  expect(executions.items.filter(item => item.nodeId === 'work')).toHaveLength(2);
  expect(executions.items.every(item => item.state === 'completed')).toBe(true);
  expect(graph.runtime.nodeRun(graph.graphId, 'work').instance!.id).toBe(instance);
  const revision = await graph.main.graphInspect({ graphId: graph.graphId, query: 'revision' }) as { modules: unknown };
  expect(revision.modules).toEqual({});
  expect(graph.runtime.artifacts.list(graph.graphId, { namespace: 'reviews', latestOnly: false }).artifacts).toHaveLength(2);
}, 30000);

test('a reviewer approved output releases only the connected downstream branch', async () => {
  const graph = await lane([{ passed: true, reason: 'Looks right' }]); await graph.run();
  expect(graph.worker.requests).toHaveLength(3); expect(graph.downstream.requests).toHaveLength(2);
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'rework' })).resolves.toMatchObject({ deliveries: [] });
  expect(graph.runtime.nodeRun(graph.graphId, 'after').node.status).toBe('succeeded');
  expect((await graph.complete()).phase).toBe('completed');
}, 30000);

test('an independent reviewer recipe and actual model history prove the reviewer approval', async () => {
  const graph = await lane([{ passed: true, reason: 'Looks right' }]); await graph.run();
  const calls = await graph.main.graphInspect({ graphId: graph.graphId, query: 'provider_calls' }) as { nodeId: string; model: { id: string; identity: string; recipe: { review: boolean } } }[];
  const reviews = calls.filter(call => call.nodeId === 'review'); expect(reviews).toHaveLength(4);
  expect(reviews.every(call => call.model.recipe.review && call.model.id === 'review')).toBe(true);
  expect(calls.filter(call => call.nodeId !== 'review').every(call => !call.model.recipe.review && call.model.identity !== reviews[0]!.model.identity)).toBe(true);
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' })).resolves.toMatchObject({ items: [{ id: 'review', status: 'passed' }] });
  expect((await graph.complete()).phase).toBe('completed');
}, 30000);

test('review acceptance pins the immutable published report bytes and version', async () => {
  const graph = await lane([{ passed: true, reason: 'Observed the persistent legend' }]); await graph.run();
  const ref = graph.artifact('reviews', 1);
  const read = await graph.runtime.artifacts.read(graph.graphId, ref.artifactId, ref.version);
  expect(JSON.parse(read.text!)).toEqual({ commit: null, passed: true, reason: 'Observed the persistent legend', subject: graph.artifact('plans', 1) });
  expect(read.record.digest).toBe(ref.digest);
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' })).resolves.toMatchObject({ items: [{ id: 'review', status: 'passed', reason: 'Observed the persistent legend', source: { id: ref.artifactId, version: 1 } }] });
}, 30000);

test('rework delivers the reviewer words while preserving the actual worker conversation', async () => {
  const graph = await lane([{ passed: false, reason: 'THE-LEGEND-IS-NOT-PERSISTENT' }, { passed: true, reason: 'Fine now' }]); await graph.run();
  const followup = (graph.worker.requests[3] as { messages: { role: string; content: unknown }[] }).messages;
  const users = followup.filter(message => message.role === 'user');
  expect(JSON.stringify(users[0])).not.toContain('THE-LEGEND-IS-NOT-PERSISTENT');
  expect(JSON.stringify(users.at(-1))).toContain('THE-LEGEND-IS-NOT-PERSISTENT');
  expect(JSON.stringify(followup)).toContain('Candidate 1 submitted');
  const rework = await graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'rework' }) as { deliveries: { value: unknown }[] };
  expect(rework.deliveries).toMatchObject([{ value: { passed: false, reason: 'THE-LEGEND-IS-NOT-PERSISTENT', report: graph.artifact('reviews', 1) } }]);
}, 30000);

test('a routed failed review cannot count as passed acceptance or trigger downstream', async () => {
  const graph = await lane([{ passed: false, reason: 'Not done' }], true);
  await graph.run();
  expect(graph.downstream.requests).toHaveLength(0);
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' })).resolves.toMatchObject({ items: [expect.anything(), expect.anything(), { nodeId: 'work', state: 'queued' }] });
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'rework' })).resolves.toMatchObject({ deliveries: [{ value: { passed: false } }] });
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' })).resolves.toMatchObject({ items: [{ id: 'review', status: 'failed', reason: 'Not done' }] });
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'results' })).resolves.toEqual([]);
  expect((await graph.complete()).phase).toBe('blocked');
}, 30000);

test('an acceptance reviewer delivers a readable exact report to downstream without replacing its submission', async () => {
  const graph = await lane([{ passed: true, reason: 'REVIEW_SUMMARY: looks right' }]); await graph.run();
  expect(graph.runtime.nodeRun(graph.graphId, 'after').node.status).toBe('succeeded');
  expect(JSON.stringify(graph.downstream.requests[1])).toContain('REVIEW_SUMMARY: looks right');
  const approved = await graph.main.graphInspect({ graphId: graph.graphId, query: 'edge', id: 'approved' }) as { deliveries: { value: { report: unknown } }[] };
  expect(approved.deliveries).toMatchObject([{ value: { report: graph.artifact('reviews', 1) } }]);
  await expect(graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' })).resolves.toMatchObject({ items: [{ status: 'passed', source: { id: graph.artifact('reviews', 1).artifactId } }] });
  expect((await graph.complete()).phase).toBe('completed');
}, 30000);
