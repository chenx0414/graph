import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const checkDefinition = parseGraphDefinition({ schemaVersion: 2, name: 'Check work', protocols: { data: { type: 'object' } }, nodes: {},
  modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
    operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
  edges: {}, acceptance: [{ id: 'works', description: 'Host runtime responds', kind: 'check', module: 'check' }] });

test('main proposes a native graph and workers receive an explicit task without copying the user chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-plan-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Title search', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement title search', acceptance: ['Search ignores case'],
      inputs: { job: { protocol: 'data' } }, outputs: { out: { protocol: 'data' } }, submission: { required: ['out'] } } },
    modules: checkDefinition.modules, edges: { checked: { from: 'work.out', to: 'check.job', enabled: true } },
    outputs: { result: { from: 'work.out', protocol: 'data' } },
    acceptance: [{ id: 'works', description: 'Search ignores case', kind: 'human' },
      { id: 'host', description: 'Host runtime responds', kind: 'check', module: 'check' }] });
  const provider = await openaiServer([
    { tools: [{ id: 'plan', name: 'propose_graph', arguments: JSON.stringify({ requestId: 'plan', proposal: {
      requirementVersion: 1, summary: 'Title search', acceptance: [{ id: 'works', description: 'Search ignores case', checkNode: 'work' },
        { id: 'host', description: 'Host runtime responds', checkNode: 'check' }], decisions: [], definition,
    } }) }] }, { text: 'Native graph proposed' },
    { tools: [{ id: 'output', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { done: true } } } }) }] },
    { text: 'Work complete' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], limits: { defaultBudgetTokens: 20_000_000 },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl,
      contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-only', modelRuntime: provider.runtime } });
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'medium' }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  cleanup.push(() => runtime.close());
  const { taskId } = await runtime.user.begin({ projectId: 'project', request: 'Ship title search USER_PRIVATE_MARKER', requestId: 'begin' });
  const task = runtime.user.task(taskId); const main = runtime.supervisor(taskId);
  expect((await task.view()).phase).toBe('discussing');
  expect(await runtime.host.runReady()).toEqual({ dispatched: 1 });
  expect((await task.view()).proposalVersion).toBe(1);
  await expect(main.propose({ requirementVersion: 1, summary: 'Bad', definition,
    acceptance: [{ id: 'works', description: 'Search ignores case', checkNode: 'missing' }],
  }, 'bad')).rejects.toMatchObject({ code: 'invalid_proposal' });
  await task.accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[0])).toContain('USER_PRIVATE_MARKER');
  await main.graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: { query: 'Title search task' } });
  await runtime.host.drive();
  const briefing = JSON.stringify(provider.requests[2]);
  expect(briefing).toContain('Title search task');
  expect(briefing).toContain('Search ignores case');
  expect(briefing).toContain('Implement title search');
  expect(briefing).not.toContain('USER_PRIVATE_MARKER');
  expect((await task.view()).nodes.map(node => node.id)).toEqual(['work']);
  await expect(main.graphInspect({ graphId: taskId, query: 'results' })).resolves.toMatchObject([{ value: { done: true } }]);
  await expect(main.graphInspect({ graphId: taskId })).resolves.toMatchObject({ phase: 'idle' });
  await main.graphControl({ graphId: taskId, action: 'complete' }); await runtime.host.drive();
  const waiting = await task.view();
  expect(waiting.phase).toBe('blocked');
  const acceptance = waiting.questions.find(question => question.kind === 'human_check')!;
  expect(acceptance, JSON.stringify(waiting.questions)).toBeDefined();
  await task.answer(acceptance.id, { type: 'acknowledge' }, 'accepted'); await runtime.host.drive();
  expect((await task.view()).phase).toBe('completed');
});

test('a separately confirmed native feature stays queued until the original graph explicitly completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m3-queue-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }] });
  cleanup.push(() => runtime.close());
  const create = async (request: string) => {
    const { taskId } = await runtime.user.begin({ projectId: 'project', request, requestId: request });
    const main = runtime.supervisor(taskId);
    const proposed = await main.propose({ requirementVersion: 1, summary: request, definition: checkDefinition,
      acceptance: [{ id: 'works', description: 'Host runtime responds', checkNode: 'check' }], decisions: [],
    }, 'proposal');
    await runtime.user.task(taskId).accept({ proposalVersion: proposed.proposalVersion, draftRevision: 1, targetBranch: 'main', requestId: `accept-${request}` });
    await main.graphSend({ graphId: taskId, nodeId: 'check', input: 'job', value: {} });
    return { taskId, main, task: runtime.user.task(taskId) };
  };
  const first = await create('Original'); const second = await create('New feature');
  expect((await second.task.view()).phase).toBe('queued');
  await runtime.host.drive();
  expect((await first.task.view()).phase).toBe('idle');
  expect((await second.task.view()).phase).toBe('queued');
  await first.main.graphControl({ graphId: first.taskId, action: 'complete' }); await runtime.host.drive();
  expect((await first.task.view()).phase).toBe('completed');
  expect((await first.task.view()).request).toBe('Original');
  expect((await second.task.view()).phase).toBe('idle');
  await second.main.graphControl({ graphId: second.taskId, action: 'complete' }); await runtime.host.drive();
  expect((await second.task.view()).phase).toBe('completed');
});
