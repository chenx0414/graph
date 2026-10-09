import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('main outside the graph shares ten global slots with native workers and reacquires capacity for the next user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-slots-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const mainRelease = deferred(); const workerRelease = deferred();
  const mainProvider = await openaiServer([{ text: 'Original plan is ready.', beforeReply: () => mainRelease.promise }, { text: 'Continue with Markdown.' }]);
  const workers = await openaiServer(Array.from({ length: 11 }, () => ({ text: 'Assigned work completed.', beforeReply: () => workerRelease.promise })));
  cleanup.push(() => mainProvider.close()); cleanup.push(() => workers.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    master: { action: 'master', definitionVersion: 'main@1', model: 'main-local' },
    models: { apiKey: 'local-only', modelRuntime: mainProvider.runtime, entries: [
      ...([['main-local', mainProvider], ['worker-local', workers]] as const).map(([id, provider]) => ({ id, provider: 'graph-openai', grade: 'high' as const,
        api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })),
    ] },
  });
  cleanup.push(() => runtime.close()); cleanup.push(async () => { mainRelease.resolve(); workerRelease.resolve(); });
  runtime.catalog.publishDefinition('main', { recommendedGrade: 'high' }, 'main');
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'high' }, 'worker');
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Parallel work', requestId: 'begin' });
  const task = runtime.user.task(taskId); const main = runtime.supervisor(taskId);
  const mainTurn = runtime.host.runReady();
  await expect.poll(() => mainProvider.requests.length, { timeout: 15000 }).toBe(1);
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Parallel work', protocols: {},
    nodes: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`worker-${index}`, { recipe: 'worker@1', model: 'worker-local', task: 'Complete the assigned work', inputs: {}, outputs: {}, submission: {} }])),
    modules: {}, edges: {},
  }) }) as { graphId: string };
  for (let index = 0; index < 11; index++) await main.graphSend({ graphId, nodeId: `worker-${index}`, text: 'Do the assigned work' });
  const driving = runtime.host.drive();
  await expect.poll(() => workers.requests.length, { timeout: 15000 }).toBe(9);
  const inspectExecutions = () => main.graphInspect({ graphId, query: 'executions' }) as Promise<{ items: { state: string }[] }>;
  expect((await inspectExecutions()).items.filter(item => item.state === 'running')).toHaveLength(9);
  expect((await runtime.user.task(graphId).view()).nodes.map(node => node.id)).not.toContain('master');
  mainRelease.resolve(); await mainTurn;
  await expect.poll(() => workers.requests.length, { timeout: 15000 }).toBe(10);
  const originalInstance = runtime.nodeRun(taskId, 'master').instance!.id;
  await task.say('Use Markdown for the result', 'answer');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 0 });
  expect(mainProvider.requests).toHaveLength(1);
  workerRelease.resolve(); await driving; await runtime.host.drive();
  expect(workers.requests).toHaveLength(11);
  expect(mainProvider.requests).toHaveLength(2);
  expect(JSON.stringify(mainProvider.requests[1])).toContain('Original plan is ready.');
  expect(JSON.stringify(mainProvider.requests[1])).toContain('Use Markdown for the result');
  expect(runtime.nodeRun(taskId, 'master').instance).toMatchObject({ id: originalInstance, used: 100 });
  expect((await inspectExecutions()).items).toHaveLength(11);
  expect((await inspectExecutions()).items.every(item => item.state === 'completed')).toBe(true);
}, 30000);

test('resolving the final native completion blocker durably advances the task queue and reconnects its event stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: join(root, 'state'), projects: [{ id: 'project', root }] };
  let runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Final acceptance', protocols: { data: { type: 'object' } }, nodes: {},
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } }, edges: {},
    acceptance: [{ id: 'works', description: 'The user accepts the result', kind: 'human' },
      { id: 'host', description: 'Host runtime responds', kind: 'check', module: 'check' }] });
  const create = async (request: string) => {
    const { taskId } = await runtime.user.begin({ projectId: 'project', request, requestId: request });
    const proposed = await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: request, definition,
      acceptance: [{ id: 'works', description: 'The user accepts the result', checkNode: 'check' },
        { id: 'host', description: 'Host runtime responds', checkNode: 'check' }] }, 'proposal');
    await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: `accept-${request}` });
    await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'check', input: 'job', value: {} });
    return taskId;
  };
  const firstId = await create('first'); const secondId = await create('second');
  expect((await runtime.user.task(secondId).view()).phase).toBe('queued');
  await runtime.supervisor(firstId).graphControl({ graphId: firstId, action: 'complete' }); await runtime.host.drive();
  const blocked = await runtime.user.task(firstId).view();
  expect(blocked.phase).toBe('blocked');
  const question = blocked.questions.find(item => item.kind === 'human_check')!;
  await runtime.user.task(firstId).answer(question.id, { type: 'acknowledge' }, 'accept-result');
  await runtime.host.drive();
  expect((await runtime.user.task(firstId).view()).phase).toBe('completed');
  expect((await runtime.user.task(secondId).view()).phase).toBe('idle');
  await runtime.close(); runtime = await openTaskRuntime(options);
  expect((await runtime.user.task(firstId).view()).phase).toBe('completed');
  expect((await runtime.user.task(secondId).view()).phase).toBe('idle');
  const updates = runtime.user.task(secondId).watch(blocked.cursor);
  expect((await updates.next()).value).toMatchObject({ type: 'task.started' }); await updates.return();
  await runtime.supervisor(secondId).graphControl({ graphId: secondId, action: 'complete' }); await runtime.host.drive();
  const next = await runtime.user.task(secondId).view();
  expect(next.phase).toBe('blocked');
  await runtime.user.task(secondId).answer(next.questions.find(item => item.kind === 'human_check')!.id, { type: 'acknowledge' }, 'acknowledge-second-result');
  await runtime.host.drive();
  expect((await runtime.user.task(secondId).view()).phase).toBe('completed');
});
