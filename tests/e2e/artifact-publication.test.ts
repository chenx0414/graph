import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Json } from '../../src/core/types.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const tool = (id: string, args: Record<string, unknown>): NonNullable<ResponsePlan['tools']>[number] => ({ id, name: 'artifact_publish', arguments: JSON.stringify(args) });

async function fixture(plans: ResponsePlan[]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-publication-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const otherProject = join(root, 'other-project'); await mkdir(project); await mkdir(otherProject);
  const vendor = await openaiServer(plans); cleanup.push(() => vendor.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }, { id: 'q', root: otherProject }],
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: vendor.runtime, entries: [{ id: 'local', provider: vendor.model.provider,
      grade: 'medium', api: 'openai-completions', baseUrl: vendor.model.baseUrl, contextWindow: 128000, maxTokens: 256 }] } });
  cleanup.push(() => runtime.close()); runtime.catalog.publishDefinition('writer', { recommendedGrade: 'medium' }, 'Publish the explicit artifact versions.');
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Publish durable artifacts', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  const { graphId } = await main.graphCreate({ definition: { schemaVersion: 2, name: 'Artifact publication', protocols: { job: { type: 'object' } },
    nodes: { writer: { recipe: 'writer@1', model: 'local', task: 'Publish the requested artifact', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } },
    modules: {}, edges: {}, inputs: {}, outputs: {} } }) as { graphId: string };
  const run = async (value: { [key: string]: Json }) => { await main.graphSend({ graphId, nodeId: 'writer', input: 'job', value }); await runtime.host.drive(); };
  return { runtime, main, graphId, vendor, run, root, project };
}

// Four actual executions each publish fewer than the per-operation quota; no fake operation IDs.
test('a real native writer maintains one document through its 101st immutable version', async () => {
  const plans: ResponsePlan[] = [];
  for (let start = 1; start <= 101; start += 26) {
    for (let version = start; version <= Math.min(start + 25, 101); version++) {
      plans.push({ tools: [tool(`publish-${version}`, { namespace: 'plans', name: 'backlog', content: `BACKLOG_VERSION_${version}`,
        requestId: `publish-${version}` })] });
    }
    plans.push({ text: 'This batch was published.' });
  }
  const graph = await fixture(plans);
  for (let batch = 0; batch < 4; batch++) await graph.run({ batch });
  const head = graph.runtime.artifacts.list(graph.graphId, { namespace: 'plans', prefix: 'backlog' }).artifacts;
  expect(head).toHaveLength(1); expect(head[0]!.version).toBe(101);
  const firstPage = graph.runtime.artifacts.list(graph.graphId, { namespace: 'plans', latestOnly: false });
  expect(firstPage).toMatchObject({ total: 101, nextCursor: '100' });
  expect(firstPage.artifacts).toHaveLength(100);
  const lastPage = graph.runtime.artifacts.list(graph.graphId, { namespace: 'plans', latestOnly: false, cursor: firstPage.nextCursor! });
  expect(lastPage).toMatchObject({ total: 101, nextCursor: null });
  expect(lastPage.artifacts).toHaveLength(1);
  expect([...firstPage.artifacts, ...lastPage.artifacts].map(item => item.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  expect((await graph.runtime.artifacts.read(graph.graphId, head[0]!.artifactId, 1)).text).toBe('BACKLOG_VERSION_1');
  expect((await graph.runtime.artifacts.read(graph.graphId, head[0]!.artifactId, 101)).text).toBe('BACKLOG_VERSION_101');
  expect(graph.runtime.nodeRun(graph.graphId, 'writer').node.status).toBe('succeeded');
  expect(graph.runtime.nodeRun(graph.graphId, 'writer').operations).toHaveLength(4);
  expect(graph.vendor.requests).toHaveLength(105);
}, 60_000);

test('native publication validates labels and logical names, preserves immutable schema bytes and refuses stale compare-and-swap', async () => {
  const first = { namespace: 'research', name: 'note', content: '{"note":"NATIVE_VERSION_ONE"}', schema: 'source-list@1', tags: ['编码', 'Known-Issue'],
    title: '中文标签', expectedVersion: 0, requestId: 'first' };
  const graph = await fixture([
    { tools: [tool('first', first)] }, { tools: [tool('replay', first)] },
    { tools: [tool('bad-tag', { ...first, tags: ['bad tag'], requestId: 'bad-tag' })] },
    { tools: [tool('bad-name', { ...first, name: '中文名', requestId: 'bad-name' })] },
    { tools: [tool('second', { ...first, content: '{"note":"NATIVE_VERSION_TWO"}', expectedVersion: 1, requestId: 'second' })] },
    { tools: [tool('stale', { ...first, content: 'STALE_MUST_NOT_PUBLISH', expectedVersion: 1, requestId: 'stale' })] },
    { text: 'Valid versions stand; invalid publications were refused.' },
  ]);
  await graph.run({ goal: 'Publish and correct a labeled version' });
  const head = graph.runtime.artifacts.list(graph.graphId, { namespace: 'research', tag: '编码' }).artifacts;
  expect(head).toHaveLength(1); expect(head[0]).toMatchObject({ version: 2, tags: ['known-issue', '编码'], schemaKind: 'source-list', schemaVersion: 1 });
  expect(graph.runtime.artifacts.list(graph.graphId, { latestOnly: false }).artifacts).toHaveLength(2);
  expect((await graph.runtime.artifacts.read(graph.graphId, head[0]!.artifactId, 1)).text).toBe('{"note":"NATIVE_VERSION_ONE"}');
  expect((await graph.runtime.artifacts.read(graph.graphId, head[0]!.artifactId, 2)).text).toBe('{"note":"NATIVE_VERSION_TWO"}');
  const lastTool = (index: number) => {
    const messages = (graph.vendor.requests[index] as { messages: { role: string; content: unknown }[] }).messages;
    const content = String(messages.filter(message => message.role === 'tool').at(-1)?.content);
    try {
      const parsed = JSON.parse(content) as { content?: { text?: string }[] };
      return parsed.content?.map(part => part.text ?? '').join('\n') ?? content;
    } catch { return content; }
  };
  expect(lastTool(1)).toContain('"version":1'); expect(lastTool(2)).toContain('"version":1');
  expect(lastTool(3)).toContain('must be a label'); expect(lastTool(4)).toContain('lowercase slug');
  expect(lastTool(6)).toContain('Artifact head changed');
  expect(graph.runtime.nodeRun(graph.graphId, 'writer').node.status).toBe('succeeded');
  expect(graph.vendor.requests).toHaveLength(7);
}, 60_000);

test('native publication refuses traversal and a real symlink without returning host bytes, and explains both supported corrections', async () => {
  const graph = await fixture([
    { tools: [tool('traversal', { namespace: 'research', name: 'traversal', sourcePath: '../host-only.txt', requestId: 'traversal' })] },
    { tools: [tool('link', { namespace: 'research', name: 'link', sourcePath: 'link.txt', requestId: 'link' })] },
    { text: 'The unsafe file publications were refused.' },
  ]);
  await writeFile(join(graph.root, 'host-only.txt'), 'HOST_ONLY_BYTES_MUST_NEVER_REACH_MODEL');
  await symlink(join(graph.root, 'host-only.txt'), join(graph.project, 'link.txt'));
  await graph.run({ goal: 'Publish the requested files' });
  const first = JSON.stringify(graph.vendor.requests[1]);
  expect(first).toContain('work copy'); expect(first).toContain('content');
  expect(JSON.stringify(graph.vendor.requests[2])).toContain('may not be a symbolic link');
  expect(JSON.stringify(graph.vendor.requests)).not.toContain('HOST_ONLY_BYTES_MUST_NEVER_REACH_MODEL');
  expect(graph.runtime.artifacts.list(graph.graphId).artifacts).toEqual([]);
  expect(graph.runtime.nodeRun(graph.graphId, 'writer').node.status).toBe('succeeded');
}, 60_000);

test('a native publication stays private until explicit exact-version project promotion and explicit retirement preserves its immutable bytes', async () => {
  const graph = await fixture([
    { tools: [tool('own', { namespace: 'plans', name: 'task-only', content: 'PRIVATE_TASK_NOTE', requestId: 'own' })] },
    { tools: [tool('shared', { namespace: 'plans', name: 'backlog', sourcePath: 'backlog.md', requestId: 'shared' })] },
    { text: 'Published the two distinct notes.' },
  ]);
  await writeFile(join(graph.project, 'backlog.md'), 'PROJECT_BACKLOG_NOTE');
  await graph.run({ goal: 'Publish a private note and reusable backlog' });
  const original = graph.runtime.artifacts.list(graph.graphId).artifacts;
  const own = original.find(item => item.name === 'task-only')!; const shared = original.find(item => item.name === 'backlog')!;
  expect((await graph.runtime.artifacts.read(graph.graphId, own.artifactId, own.version)).text).toBe('PRIVATE_TASK_NOTE');
  expect(graph.runtime.artifacts.listProject('p').artifacts).toEqual([]);
  const other = await graph.runtime.user.begin({ projectId: 'p', request: 'Another task', requestId: 'other' });
  expect(graph.runtime.artifacts.list(other.taskId).artifacts).toEqual([]);
  await expect(graph.runtime.artifacts.read(other.taskId, own.artifactId, own.version)).rejects.toMatchObject({ code: 'not_found' });
  const promoted = await graph.runtime.artifacts.promote({ taskId: graph.graphId, artifactId: shared.artifactId, version: shared.version, requestId: 'promote' });
  expect(promoted).toMatchObject({ scope: 'project', projectId: 'p', version: 1, uri: 'graph://projects/p/artifacts/plans/backlog@1' });
  expect(graph.runtime.artifacts.get(graph.graphId, promoted.artifactId, promoted.version)).toMatchObject({ scope: 'project', name: 'backlog' });
  expect(graph.runtime.artifacts.get(graph.graphId, shared.artifactId, shared.version).scope).toBe('task');
  expect(promoted.artifactId).not.toBe(shared.artifactId);
  expect(graph.runtime.artifacts.listProject('p').artifacts.map(item => item.name)).toEqual(['backlog']);
  expect(graph.runtime.artifacts.listProject('p', { prefix: 'backl' }).artifacts).toHaveLength(1);
  expect(graph.runtime.artifacts.listProject('p', { prefix: 'nope' }).artifacts).toEqual([]);
  expect(graph.runtime.artifacts.listProject('q').artifacts).toEqual([]);
  expect(graph.runtime.artifacts.list(graph.graphId).artifacts.map(item => `${item.name}@${item.scope}`).sort()).toEqual(['backlog@project', 'backlog@task', 'task-only@task']);
  expect(graph.runtime.artifacts.list(other.taskId).artifacts).toMatchObject([{ artifactId: promoted.artifactId, scope: 'project' }]);
  expect((await graph.runtime.artifacts.read(other.taskId, promoted.artifactId, promoted.version)).text).toBe('PROJECT_BACKLOG_NOTE');
  const foreign = await graph.runtime.user.begin({ projectId: 'q', request: 'Another project', requestId: 'foreign' });
  expect(graph.runtime.artifacts.list(foreign.taskId).artifacts).toEqual([]);
  await expect(graph.runtime.artifacts.read(foreign.taskId, promoted.artifactId, promoted.version)).rejects.toMatchObject({ code: 'not_found' });
  graph.runtime.artifacts.retire({ taskId: graph.graphId, artifactId: own.artifactId, version: own.version, reason: 'Superseded note', requestId: 'retire' });
  expect(graph.runtime.artifacts.get(graph.graphId, own.artifactId, own.version).state).toBe('retired');
  expect(graph.runtime.artifacts.list(graph.graphId).artifacts.map(item => item.artifactId)).not.toContain(own.artifactId);
  expect(graph.runtime.artifacts.list(graph.graphId, { includeRetired: true }).artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: own.artifactId, state: 'retired' })]));
  expect((await graph.runtime.artifacts.read(graph.graphId, own.artifactId, own.version)).text).toBe('PRIVATE_TASK_NOTE');
}, 60_000);
