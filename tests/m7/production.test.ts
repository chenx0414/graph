import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { Proposal } from '../../src/core/types.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { TaskStore } from '../../src/core/store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { cloneMediaBookmarks, mediaBookmarksSource } from './clone.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const payloadDir = fileURLToPath(new URL('../fixtures/m7/', import.meta.url));

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

test('production Pi writes the Bilibili web on a clone through workspace tools and merges after review', async () => {
  const source = mediaBookmarksSource();
  const sourceHead = git(source, ['rev-parse', 'HEAD']);
  const sourceStatus = git(source, ['status', '--porcelain']);
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-prod-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = cloneMediaBookmarks(join(parent, 'project'), source);
  const server = await readFile(join(payloadDir, 'web-server.js'), 'utf8');
  const page = await readFile(join(payloadDir, 'index.html'), 'utf8');
  const testFile = await readFile(join(payloadDir, 'web-server.test.js'), 'utf8');
  let graphId = '';
  let disk: TaskStore;
  const provider = await openaiServer([
    { tools: [
      { id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'src/web-server.js', content: server }) },
      { id: 'w2', name: 'write_file', arguments: JSON.stringify({ path: 'src/web/index.html', content: page }) },
      { id: 'w3', name: 'write_file', arguments: JSON.stringify({ path: 'test/web-server.test.js', content: testFile }) },
    ] },
    { text: 'Wrote the Bilibili web files.' },
    { tools: ['src/web-server.js', 'src/web/index.html', 'test/web-server.test.js'].map((path, index) => ({ id: `read-${index}`, name: 'read', arguments: JSON.stringify({ path }) })) },
    { tools: [{ id: 'report', name: 'write_file', arguments: () => JSON.stringify({ path: 'review.json', content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: true, reason: 'Reviewed exclusive profile, collection lock, API behavior and fixture tests' }) }) }] },
    { text: 'Published an independent review of the current commit.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    access: () => fullAccessPolicy(), // The real Web API tests listen locally and spawn the CLI.
    projects: [{ id: 'media-bookmarks', root }],
    models: {
      entries: [
        { id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 8_192 },
        { id: 'reader', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
      ],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId, conversationId } = await runtime.conversations.create({
    projectId: 'media-bookmarks', text: '为本机 MediaBookmarks 增加 B站 Web：确认登录、采集、进度与失败原因、浏览收藏和笔记、导出 Markdown。', requestId: 'begin',
  });
  const main = runtime.supervisor(taskId);
  const checks = [
    { id: 'login-status', description: '页面展示 B站登录态，并标明独立 profile 与不可并发采集' },
    { id: 'collect-progress', description: '可发起采集并看到进度与失败原因' },
    { id: 'browse-notes', description: '可浏览收藏条目与已有 Markdown 笔记' },
    { id: 'export-md', description: '可导出 Markdown 并得到非空结果' },
  ];
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Bilibili native production', protocols: { data: { type: 'object' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'local', task: '实现 B站 Web，使用独立 .browser-profile，禁止并发采集，不共享日常 Chrome。', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
      review: { recipe: 'reviewer@1', model: 'reader', task: '独立审查实际文件及当前 commit，发布审查报告。', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
        deliverable: { path: 'review.json', namespace: 'reviews', name: 'bilibili-review', schema: 'graph.review@1' } },
    },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--test', 'test/web-server.test.js'], output: 'result', sandbox: false, timeoutMs: 12000 } } },
    edges: { checked: { from: 'check.result', to: 'review.job', enabled: true } },
    acceptance: [
      ...checks.map(item => ({ ...item, kind: 'check', module: 'check' })),
      { id: 'review', description: 'Independent review of this commit', kind: 'review', node: 'review' },
      { id: 'human-login', description: '使用者在独立 profile 完成 B站登录后确认', kind: 'human' },
    ],
  });
  const proposed = await main.propose({ requirementVersion: 1, summary: definition.name, definition,
    acceptance: definition.acceptance!.map(item => ({ id: item.id, description: item.description, checkNode: item.kind === 'check' ? 'check' : 'review' })),
  } as Proposal, 'm7-prod-plan');
  const receipt = await runtime.conversations.confirm(conversationId, { proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  graphId = receipt.taskId;
  await expect(main.revise({ taskId: graphId, baseVersion: 1, reason: 'Legacy revision must not touch a native graph', nodes: [], requestId: 'legacy-revision' })).rejects.toMatchObject({ code: 'invalid_graph' });
  const task = runtime.user.task(graphId);
  disk = new TaskStore(join(root, 'state', 'tasks.sqlite')); cleanup.push(async () => disk.close());
  expect((await task.view()).nodes.every(node => node.status === 'idle')).toBe(true);
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
  const checkResult = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
  expect(checkResult.items.map(item => [item.id, item.status])).toEqual([...checks.map(item => [item.id, 'passed']), ['review', 'passed'], ['human-login', 'missing']]);
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  const blocked = await task.view();
  const human = blocked.questions.filter(question => question.kind === 'human_check' && question.status === 'open');
  expect(human).toMatchObject([{ nodeId: '@acceptance/human-login', data: { commitSha: blocked.integrationSha } }]);
  const reviewRequests = (provider.requests as { model: string }[]).filter(request => request.model === 'reader');
  expect(JSON.stringify(reviewRequests)).toContain('collect_busy');
  await task.answer(human[0]!.id, { type: 'acknowledge' }, 'login');
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(await readFile(join(root, 'src/web-server.js'), 'utf8')).toContain('not_logged_in');
  expect(await readFile(join(root, 'src/web/index.html'), 'utf8')).toContain('note-body');
  expect(existsSync(join(root, 'test/web-server.test.js'))).toBe(true);
  expect(git(source, ['rev-parse', 'HEAD'])).toBe(sourceHead);
  expect(git(source, ['status', '--porcelain'])).toBe(sourceStatus);
  expect((await runtime.conversations.view(conversationId)).tasks.map(task => task.id)).toEqual([graphId]);
}, 30_000);
