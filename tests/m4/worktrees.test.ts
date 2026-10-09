import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { git, nativeWorktreeGraph } from '../fixtures/native-worktree-graph.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const run = (files: Record<string, { path: string; content: string; workspacePath?: string }>) => nativeWorktreeGraph(cleanup, files);

test('a native Agent worktree commit uses the recipe display name as author and committer', async () => {
  const graph = await run({ work: { path: 'agent.txt', content: 'named commit\n' } }); await graph.work();
  expect(graph.runtime.nodeRun(graph.graphId, 'work').node.status).toBe('succeeded');
  expect(git(graph.tree('work'), ['log', '-1', '--format=%an <%ae>|%cn <%ce>']))
    .toBe('代码实现 <coder@agents.graph.local>|代码实现 <coder@agents.graph.local>');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  expect((await graph.finish()).phase).toBe('completed');
}, 30000);

test('parallel native instances write in separate worktrees and both reach integration and the verified target', async () => {
  const graph = await run({ left: { path: 'left.txt', content: 'L', workspacePath: 'nested' }, right: { path: 'right.txt', content: 'R' } }); await graph.work();
  expect(graph.tree('left')).not.toBe(graph.tree('right'));
  expect(graph.runtime.nodeRun(graph.graphId, 'left')).toMatchObject({ environment: { workspace: join(graph.tree('left'), 'nested'), base: 'worktree' } });
  expect(await readFile(join(graph.tree('left'), 'nested', 'left.txt'), 'utf8')).toBe('L');
  expect(await readFile(join(graph.tree('right'), 'right.txt'), 'utf8')).toBe('R');
  const integration = (graph.disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graph.graphId}`) as { path: string }).path;
  expect(await readFile(join(integration, 'nested', 'left.txt'), 'utf8')).toBe('L'); expect(await readFile(join(integration, 'right.txt'), 'utf8')).toBe('R');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
  const view = await graph.finish(); expect(view.phase).toBe('completed');
  const acceptance = await graph.main.graphInspect({ graphId: graph.graphId, query: 'acceptance' }) as { items: { status: string; source: { commit: string } }[] };
  expect(acceptance.items).toHaveLength(2);
  for (const item of acceptance.items) expect(item).toMatchObject({ status: 'passed', source: { commit: view.integrationSha } });
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(view.integrationSha);
  expect(await readFile(join(graph.project, 'nested', 'left.txt'), 'utf8')).toBe('L'); expect(await readFile(join(graph.project, 'right.txt'), 'utf8')).toBe('R');
  const reviewed = (graph.reviewer.requests[2] as { messages: { role: string; content: string }[] }).messages
    .filter(message => message.role === 'tool').flatMap(message => {
      const result = JSON.parse(message.content) as { content: { type: string; text: string }[] };
      return result.content.filter(part => part.type === 'text').map(part => JSON.parse(part.text) as { text: string });
    });
  expect(reviewed.map(item => item.text).sort()).toEqual(['L', 'R']);
}, 30000);

test('a real native integration conflict preserves both worktrees and parks only the conflicting execution', async () => {
  const graph = await run({ left: { path: 'same.txt', content: 'left' }, right: { path: 'same.txt', content: 'right' } }); await graph.work();
  expect(await readFile(join(graph.tree('left'), 'same.txt'), 'utf8')).toBe('left');
  expect(await readFile(join(graph.tree('right'), 'same.txt'), 'utf8')).toBe('right');
  const runs = ['left', 'right'].map(id => graph.runtime.nodeRun(graph.graphId, id));
  expect(runs.map(run => run.node.status).sort()).toEqual(['failed', 'succeeded']);
  expect(graph.runtime.events(graph.graphId).filter(event => event.type === 'graph.node.failed')).toMatchObject([{ data: { reason: expect.stringContaining('same.txt') } }]);
  const queue = await graph.main.graphInspect({ graphId: graph.graphId, query: 'queue' }) as { items: { state: string }[] };
  expect(queue.items.map(item => item.state).sort()).toEqual(['done', 'failed']);
  expect(graph.reviewer.requests).toHaveLength(0);
  await graph.main.graphControl({ graphId: graph.graphId, action: 'complete' }); await graph.runtime.host.drive();
  expect((await graph.runtime.user.task(graph.graphId).view()).phase).toBe('blocked');
  expect(git(graph.project, ['rev-parse', 'HEAD'])).toBe(graph.baseline);
}, 30000);
