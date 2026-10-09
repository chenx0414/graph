import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { git, nativeWorktreeGraph } from '../fixtures/native-worktree-graph.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
async function colliding() {
  const graph = await nativeWorktreeGraph(cleanup, { left: { path: 'shared.txt', content: 'left' }, right: { path: 'shared.txt', content: 'right' } });
  await graph.work();
  const queue = await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' }) as { items: { seq: number; nodeId: string; state: string }[] };
  const failed = queue.items.find(item => item.state === 'failed');
  if (!failed) throw new Error('Expected a genuine same-file Git conflict');
  return { graph, failed };
}

test('a native merge conflict pauses later deliveries to that node until main explicitly disposes of them', async () => {
  const { graph, failed } = await colliding();
  const requests = graph.providers[failed.nodeId]!.requests.length;
  await graph.main.graphSend({ graphId: graph.graphId, nodeId: failed.nodeId, input: 'job', value: { message: 'Later input stays queued' } });
  await graph.runtime.host.drive();
  const queue = await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' }) as { items: { seq: number; state: string }[] };
  expect(queue.items.map(item => item.state).sort()).toEqual(['done', 'failed', 'queued']);
  expect(graph.providers[failed.nodeId]!.requests).toHaveLength(requests);
  const later = queue.items.find(item => item.state === 'queued')!;
  await graph.main.graphControl({ graphId: graph.graphId, action: 'cancel', seq: later.seq });
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' })).toMatchObject({ items: [
    expect.anything(), expect.anything(), { seq: later.seq, state: 'done', reason: expect.stringContaining('cancel') },
  ] });
  expect(await readFile(join(graph.tree('left'), 'shared.txt'), 'utf8')).toBe('left');
  expect(await readFile(join(graph.tree('right'), 'shared.txt'), 'utf8')).toBe('right');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
}, 30000);

test('restarting a native graph retains the failed merge input without launching a hidden resolver or replaying either worker', async () => {
  const { graph, failed } = await colliding();
  const before = await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' });
  const counts = Object.fromEntries(Object.entries(graph.providers).map(([id, provider]) => [id, provider.requests.length]));
  const sha = graph.disk.task(graph.graphId).integration_sha;
  await graph.reopen(); await graph.runtime.host.drive();
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' })).toEqual(before);
  expect(graph.runtime.nodeRun(graph.graphId, failed.nodeId).node.status).toBe('failed');
  expect(graph.disk.task(graph.graphId).integration_sha).toBe(sha);
  for (const [id, provider] of Object.entries(graph.providers)) expect(provider.requests).toHaveLength(counts[id]!);
  expect(graph.reviewer.requests).toHaveLength(0);
  expect(graph.runtime.events(graph.graphId).filter(event => event.type.startsWith('git.conflict.merge_attempt'))).toHaveLength(0);
}, 30000);

test('skipping a failed native merge input never supplies acceptance evidence or silently delivers a one-sided integration', async () => {
  const { graph, failed } = await colliding();
  await graph.main.graphControl({ graphId: graph.graphId, action: 'skip', seq: failed.seq });
  await graph.main.graphControl({ graphId: graph.graphId, action: 'complete' }); await graph.runtime.host.drive();
  expect((await graph.runtime.user.task(graph.graphId).view()).phase).toBe('blocked');
  expect(await graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' })).toMatchObject({ items: [
    { id: 'works', status: 'missing' }, { id: 'review', status: 'missing' },
  ] });
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  expect(graph.reviewer.requests).toHaveLength(0);
}, 30000);
