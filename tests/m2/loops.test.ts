import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const submit = (value: () => unknown): ResponsePlan => ({ tools: [{ id: 'submit', name: 'submit', arguments: () => JSON.stringify({ outputs: { result: { enable: true, value: value() } } }) }] });

async function rework() {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-loop-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>; let graphId = '';
  const version = (round: number) => runtime.artifacts.list(graphId, { namespace: 'plans', latestOnly: false }).artifacts.find(item => item.version === round)!;
  const reference = (round: number) => { const artifact = version(round); return { artifactId: artifact.artifactId, version: artifact.version, digest: artifact.digest }; };
  const worker = await openaiServer([1, 2].flatMap(round => [
    { tools: [{ id: `publish-${round}`, name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'candidate', mediaType: 'text/markdown', content: `version ${round}`, requestId: `candidate-${round}` }) }] },
    submit(() => ({ round, subject: reference(round) })), { text: `Candidate ${round} submitted` },
  ]));
  const reviewer = await openaiServer([1, 2].flatMap(round => [
    { tools: [{ id: `read-${round}`, name: 'artifact_read', arguments: () => JSON.stringify(reference(round)) }] },
    submit(() => ({ round, subject: reference(round), passed: round === 2, reason: round === 1 ? 'First attempt is incomplete' : 'Current candidate passes' })),
    { text: `Review ${round} submitted` },
  ]));
  const sibling = await openaiServer([{ text: 'Unchanged sibling completed' }]);
  for (const provider of [worker, reviewer, sibling]) cleanup.push(() => provider.close());
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }], models: { apiKey: 'local-only', modelRuntime: worker.runtime,
    entries: ([['worker', worker], ['reviewer', reviewer], ['sibling', sibling]] as const).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) } };
  runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: 'Rework the candidate', requestId: 'begin' });
  const main = runtime.supervisor(ownerId);
  graphId = ((await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Explicit rework', protocols: { data: { type: 'object' } }, nodes: {
    work: { recipe: 'coder@1', model: 'worker', task: 'Publish and submit a stable candidate version', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
    review: { recipe: 'coder@1', model: 'reviewer', task: 'Read and judge the exact published candidate version', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
    sibling: { recipe: 'coder@1', model: 'sibling', task: 'Complete independent work once', inputs: {}, outputs: {}, submission: {} },
  }, modules: { gate: { type: 'router', trigger: 'each', inputs: { review: { protocol: 'data' } }, outputs: { rework: { protocol: 'data' }, approved: { protocol: 'data' } },
    rules: [{ when: 'review.passed == false', emit: { rework: '$review' } }, { when: 'review.passed == true', emit: { approved: '$review' } }] } },
  edges: { reviewed: { from: 'work.result', to: 'review.job', enabled: true }, judged: { from: 'review.result', to: 'gate.review', enabled: true }, rework: { from: 'gate.rework', to: 'work.job', enabled: true } },
  outputs: { result: { from: 'gate.approved', protocol: 'data' } } }) })) as { graphId: string }).graphId;
  return { root, runtime, main, graphId, ownerId, options, worker, reviewer, sibling, reference, replaceRuntime: (next: typeof runtime) => { runtime = next; } };
}

test.each(['identity', 'versions'] as const)('native rework preserves the original instance and uses explicit current review references: %s', async contract => {
  const fixture = await rework(); const { runtime, main, graphId, worker, reviewer, sibling, reference } = fixture;
  const instance = runtime.nodeRun(graphId, 'work').instance!.id;
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { goal: 'Produce a correct candidate' } });
  await main.graphSend({ graphId, nodeId: 'sibling', text: 'Complete independent work' }); await runtime.host.drive();
  expect(worker.requests).toHaveLength(6); expect(reviewer.requests).toHaveLength(6); expect(sibling.requests).toHaveLength(1);
  expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ id: instance, used: 300 });
  const gate = await main.graphInspect({ graphId, query: 'module', id: 'gate' }) as { transitions: { outputs: Record<string, unknown> }[] };
  expect(gate.transitions).toMatchObject([{ outputs: { rework: { passed: false, subject: reference(1) } } }, { outputs: { approved: { passed: true, subject: reference(2) } } }]);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { passed: true, subject: reference(2) } }]);
  if (contract === 'identity') {
    expect(JSON.stringify(worker.requests[3])).toContain('First attempt is incomplete');
    expect(JSON.stringify(worker.requests[3])).toContain('Candidate 1 submitted');
    const executions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
    expect(executions.items.filter(item => item.nodeId === 'work')).toHaveLength(2);
    expect(executions.items.every(item => item.state === 'completed')).toBe(true);
  } else {
    expect(reference(1).digest).not.toBe(reference(2).digest);
    expect((await runtime.artifacts.read(graphId, reference(1).artifactId, 1)).text).toBe('version 1');
    expect((await runtime.artifacts.read(graphId, reference(2).artifactId, 2)).text).toBe('version 2');
    expect(JSON.stringify(reviewer.requests[1])).toContain('version 1');
    expect(JSON.stringify(reviewer.requests[4])).toContain('version 2');
    const latest = (reviewer.requests[3] as { messages: { role: string; content: string | { text?: string }[] }[] }).messages.filter(message => message.role === 'user').at(-1)!;
    const text = typeof latest.content === 'string' ? latest.content : latest.content.map(part => part.text ?? '').join('\n');
    expect(text).toContain('"version":2');
  }
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'idle' });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect(await runtime.user.task(graphId).view()).toMatchObject({ phase: 'completed' });
});

test('native queued rework survives restart without repeating completed input or changing the original instance', async () => {
  const fixture = await rework(); const { runtime, main, graphId, worker, reviewer, ownerId, options, reference } = fixture;
  const instance = runtime.nodeRun(graphId, 'work').instance!.id;
  await main.graphControl({ graphId, action: 'pause', moduleId: 'gate' });
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  expect(worker.requests).toHaveLength(3); expect(reviewer.requests).toHaveLength(3);
  await expect(main.graphInspect({ graphId, query: 'results' })).resolves.toEqual([]);
  await runtime.close();
  const restored = await openTaskRuntime(options); fixture.replaceRuntime(restored); cleanup.push(() => restored.close());
  const recovered = restored.supervisor(ownerId); await restored.host.drive();
  expect(worker.requests).toHaveLength(3);
  await recovered.graphControl({ graphId, action: 'resume', moduleId: 'gate' }); await restored.host.drive();
  expect(worker.requests).toHaveLength(6); expect(reviewer.requests).toHaveLength(6);
  expect(restored.nodeRun(graphId, 'work').instance).toMatchObject({ id: instance, used: 300 });
  await expect(recovered.graphInspect({ graphId, query: 'results' })).resolves.toMatchObject([{ value: { subject: reference(2) } }]);
  await expect(recovered.graphInspect({ graphId, query: 'queue' })).resolves.toMatchObject({ items: [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }] });
});

test('native full access does not repeatedly execute a failed custom module, including after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-failed-module-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'failed.mjs'); await writeFile(entry, "export function evaluate(){throw new Error('column index out of range')}");
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy() };
  const runtime = await openTaskRuntime(options); cleanup.push(() => runtime.close());
  const { taskId: ownerId } = await runtime.user.begin({ projectId: 'p', request: 'Contain failed module', requestId: 'begin' });
  const main = runtime.supervisor(ownerId);
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Failed module', protocols: { data: { type: 'object' } }, nodes: {}, modules: {
    check: { type: 'command', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, code: { entry, version: 1 } },
  }, edges: {} }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: { original: true } });
  for (let tick = 0; tick < 3; tick++) await runtime.host.drive();
  const failures = runtime.events(graphId, 0).filter(event => event.type === 'graph.module.failed');
  expect(failures).toMatchObject([{ data: { moduleId: 'check', reason: 'column index out of range' } }]);
  await expect(main.graphInspect({ graphId, query: 'module', id: 'check' })).resolves.toMatchObject({ inputs: [{ value: { original: true } }], transitions: [] });
  await runtime.close(); const restored = await openTaskRuntime(options); cleanup.push(() => restored.close());
  for (let tick = 0; tick < 3; tick++) await restored.host.drive();
  expect(restored.events(graphId, 0).filter(event => event.type === 'graph.module.failed')).toEqual(failures);
  await restored.supervisor(ownerId).graphControl({ graphId, action: 'complete' }); await restored.host.drive();
  expect(await restored.user.task(graphId).view()).toMatchObject({ phase: 'blocked' });
});
