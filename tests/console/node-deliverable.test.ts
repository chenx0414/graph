import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { parseGraphDefinition, type NodeDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture(plans: ResponsePlan[], deliverable: NonNullable<NodeDefinition['deliverable']>, reader = false) {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-deliverable-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }], actions: {},
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, fileURLToPath(new URL('../../presets', import.meta.url)));
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: '交回一份笔记', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: '发布节点声明的文件',
    acceptance: [{ id: 'ok', description: '用户检查笔记', checkNode: 'work' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: '文件交付',
      protocols: { job: { type: 'object' }, artifact: { type: 'object', required: ['artifactId', 'version'],
        properties: { artifactId: { type: 'string' }, version: { type: 'integer' } } } },
      nodes: {
        work: { recipe: 'coder@1', model: 'local', task: '写入声明的文件，完成后回复。', deliverable,
          inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} },
        ...(reader ? { reader: { recipe: 'coder@1', model: 'local', task: '读取传入的精确产物版本并回复。',
          inputs: { artifact: { protocol: 'artifact' } }, outputs: {}, submission: {} } } : {}),
      }, modules: {}, edges: {}, acceptance: [{ id: 'ok', description: '用户检查笔记', kind: 'human' }] }),
  }, 'draft');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: {} });
  await runtime.host.drive();
  return { runtime, taskId, provider };
}

const note = { path: 'notes/lane.md', namespace: 'research' as const, name: 'lane-notes', title: 'lane notes' };
const writeNote = { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: note.path, content: '# lane notes\n' }) }] };

test('a native node declares a file and the harness publishes the actual Pi-written bytes', async () => {
  const { runtime, taskId } = await fixture([writeNote, { text: 'Finished writing.' }], note);
  const published = runtime.artifacts.list(taskId).artifacts.find(item => item.name === note.name);
  expect(published).toMatchObject({ scope: 'task', namespace: 'research', title: 'lane notes', producer: { nodeId: 'work' } });
  expect((await runtime.artifacts.read(taskId, published!.artifactId, published!.version)).text).toBe('# lane notes\n');
  const work = await runtime.nodeRun(taskId, 'work');
  expect(work.node.status).toBe('succeeded');
  expect(work.entries.find(entry => entry.role === 'tool' && entry.kind === 'call')).toMatchObject({ data: { toolName: 'write_file' } });
}, 30_000);

test('an explicit native input lets another node read the exact automatically published version', async () => {
  let reference: { artifactId: string; version: number };
  const { runtime, taskId, provider } = await fixture([writeNote, { text: 'Finished writing.' },
    { tools: [{ id: 'read', name: 'artifact_read', arguments: () => JSON.stringify(reference) }] },
    { text: 'Read the published lane notes.' },
  ], note, true);
  const published = runtime.artifacts.list(taskId).artifacts.find(item => item.name === note.name)!;
  reference = { artifactId: published.artifactId, version: published.version };
  expect((await runtime.nodeRun(taskId, 'reader')).operations).toHaveLength(0);
  await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'reader', input: 'artifact', value: reference });
  await runtime.host.drive();
  const reader = await runtime.nodeRun(taskId, 'reader');
  expect(reader.node.status).toBe('succeeded');
  expect(reader.entries.find(entry => entry.role === 'tool' && entry.kind === 'result')?.text).toContain('# lane notes');
  expect(JSON.stringify(provider.requests[2])).toContain(published.artifactId);
  expect(reader.entries[0]?.text).toContain(JSON.stringify(reference));
}, 30_000);

test('the harness does not publish a duplicate of bytes already published by the real node tool', async () => {
  const { runtime, taskId } = await fixture([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'reviews/lane.md', content: '# lane review\n' }) }] },
    { tools: [{ id: 'publish', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'reviews', name: 'lane',
      sourcePath: 'reviews/lane.md', title: 'lane review', requestId: 'node-publish' }) }] },
    { text: 'Published the review.' },
  ], { path: 'reviews/lane.md', namespace: 'reviews', name: 'lane', title: 'lane review' });
  const all = runtime.artifacts.list(taskId, { namespace: 'reviews', latestOnly: false }).artifacts;
  expect(all.filter(item => item.name === 'lane').map(item => item.version)).toEqual([1]);
  expect(all[0]?.title).toBe('lane review');
  const work = await runtime.nodeRun(taskId, 'work');
  expect(work.node.status).toBe('succeeded');
  expect(work.entries.find(entry => entry.role === 'tool' && entry.kind === 'result' && entry.text?.includes('artifactId'))?.text).toContain(all[0]!.artifactId);
}, 30_000);

test('a missing declared file fails native execution and retains the input for main to handle', async () => {
  const { runtime, taskId } = await fixture([{ text: 'Finished without writing.' }],
    { path: 'notes/missing.md', namespace: 'research', name: 'missing-notes' });
  expect((await runtime.nodeRun(taskId, 'work')).node.status).toBe('failed');
  expect(runtime.artifacts.list(taskId).artifacts).toHaveLength(0);
  const queue = await runtime.supervisor(taskId).graphInspect({ graphId: taskId, query: 'queue' });
  expect(queue).toMatchObject({ items: [{ nodeId: 'work', state: 'failed', reason: expect.stringMatching(/never written/i) }] });
}, 30_000);
