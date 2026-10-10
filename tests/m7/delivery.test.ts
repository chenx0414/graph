import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { cloneMediaBookmarks, mediaBookmarksSource } from './clone.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

// These demo tests build their fixture from the sibling MediaBookmarks checkout. Where that
// checkout is absent the test cannot run: skipping names the real reason instead of failing the
// whole activation gate on a fact about another repository.
const sourceAvailable = existsSync(join(mediaBookmarksSource(), '.git'));

test.skipIf(!sourceAvailable)('native Graph delivers the Bilibili web from independent workers after real checks, published review and human login acceptance', async () => {
  const source = mediaBookmarksSource();
  const sourceHead = git(source, ['rev-parse', 'HEAD']);
  const sourceStatus = git(source, ['status', '--porcelain']);
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = cloneMediaBookmarks(join(parent, 'project'), source);
  expect(existsSync(join(root, 'src/cli.js'))).toBe(true);
  for (const excluded of ['node_modules', '.browser-profile', 'output']) expect(existsSync(join(root, excluded))).toBe(false);
  const payload = async (name: string) => readFile(new URL(`../fixtures/m7/${name}`, import.meta.url), 'utf8');
  const originalPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const api = await openaiServer([
    { tools: [
      { id: 'api', name: 'write_file', arguments: JSON.stringify({ path: 'src/web-server.js', content: await payload('web-server.js') }) },
      { id: 'package', name: 'write_file', arguments: JSON.stringify({ path: 'package.json', content: JSON.stringify({ ...originalPackage, scripts: { ...originalPackage.scripts, web: 'node src/web-server.js' } }, null, 2) + '\n' }) },
    ] }, { text: 'Implemented the API and preserved the existing CLI scripts.' },
  ]);
  cleanup.push(() => api.close());
  const ui = await openaiServer([
    { tools: [{ id: 'ui', name: 'write_file', arguments: JSON.stringify({ path: 'src/web/index.html', content: await payload('index.html') }) }] },
    { text: 'Implemented the local Web interface.' },
  ]);
  cleanup.push(() => ui.close());
  const tester = await openaiServer([
    { tools: [{ id: 'read-api', name: 'read', arguments: JSON.stringify({ path: 'src/web-server.js' }) }, { id: 'read-ui', name: 'read', arguments: JSON.stringify({ path: 'src/web/index.html' }) }] },
    { tools: [{ id: 'test', name: 'write_file', arguments: JSON.stringify({ path: 'test/web-server.test.js', content: await payload('web-server.test.js') }) }] },
    { text: 'Implemented the fixture API tests against the integrated API and interface.' },
  ]);
  cleanup.push(() => tester.close());
  let graphId = '';
  let disk: TaskStore;
  const reviewer = await openaiServer([
    { tools: ['src/web-server.js', 'src/web/index.html', 'test/web-server.test.js'].map((path, index) => ({ id: `read-${index}`, name: 'read', arguments: JSON.stringify({ path }) })) },
    { tools: [
      { id: 'notes', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'reviews', name: 'bilibili-web-notes', mediaType: 'text/markdown', content: '# B站 Web 独立审查\n\n结论：pass\n\n确认独立 profile、不可并发采集、合成夹具测试，以及目标仍为 JavaScript。\n', requestId: 'review-notes' }) },
      { id: 'report', name: 'write_file', arguments: () => JSON.stringify({ path: 'review.json', content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: true, reason: 'Independent review of the integrated Bilibili implementation and fixture tests' }) }) },
    ] }, { text: 'Published the current commit review and shared Markdown notes.' },
  ]);
  cleanup.push(() => reviewer.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'media-bookmarks', root }], access: () => fullAccessPolicy(),
    models: { apiKey: 'scripted-local-key', modelRuntime: api.runtime, entries: [
      ...([['api', api], ['ui', ui], ['tester', tester], ['reader', reviewer]] as const).map(([id, provider]) => ({
        id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 8192,
      })),
    ] },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId, conversationId } = await runtime.conversations.create({ projectId: 'media-bookmarks', text: '为本机 MediaBookmarks 增加 B站 Web：确认登录、采集、进度与失败原因、浏览收藏和笔记、导出 Markdown。', requestId: 'begin' });
  await runtime.user.task(taskId).say('界面为本机页面；使用 GRAPH_FIXTURE 合成条目；登录在独立 .browser-profile 用 CLI 完成后确认人工检查项。目标分支 main。', 'discuss');
  const main = runtime.supervisor(taskId);
  const checks = [
    { id: 'login-status', description: '页面展示 B站登录态，并标明独立 profile 与不可并发采集' },
    { id: 'collect-progress', description: '可发起采集并看到进度与失败原因' },
    { id: 'browse-notes', description: '可浏览收藏条目与已有 Markdown 笔记' },
    { id: 'export-md', description: '可导出 Markdown 并得到非空结果' },
  ];
  const worker = (model: string, task: string) => ({ recipe: 'coder@1', model, task, inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Bilibili independent workers', protocols: { data: { type: 'object' } },
    nodes: {
      'web-api': worker('api', '实现 API：独立 .browser-profile、禁止并发采集、不共享日常 Chrome，保留其他平台 CLI。'),
      'web-ui': worker('ui', '实现本机界面，展示登录、采集进度及失败原因、笔记与 Markdown 导出。'),
      'web-test': worker('tester', '读取已集成 API/UI，使用 GRAPH_FIXTURE 编写真实 Web API 检查。'),
      review: { recipe: 'reviewer@1', model: 'reader', task: '独立审查当前实现，发布 Markdown 说明与当前 commit 的 graph.review@1 报告。', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {}, deliverable: { path: 'review.json', namespace: 'reviews', name: 'review', schema: 'graph.review@1' } },
    },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--test', 'test/web-server.test.js'], output: 'result', sandbox: false, timeoutMs: 12000 } } },
    edges: { checked: { from: 'check.result', to: 'review.job', enabled: true } },
    acceptance: [...checks.map(item => ({ ...item, kind: 'check', module: 'check' })), { id: 'review', description: 'Independent review of this commit', kind: 'review', node: 'review' }, { id: 'human-login', description: '使用者在独立 profile 完成 B站登录后确认', kind: 'human' }],
  });
  const proposed = await main.propose({ requirementVersion: 2, summary: '独立 profile，禁止并发采集，不共享日常 Chrome；并行 API/UI、集成后测试与审查、人工登录确认。', definition, acceptance: definition.acceptance!.map(item => ({ id: item.id, description: item.description, checkNode: item.kind === 'check' ? 'check' : 'review' })) }, 'plan');
  const confirmed = await runtime.conversations.confirm(conversationId, { proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  graphId = confirmed.taskId;
  disk = new TaskStore(join(root, 'state', 'tasks.sqlite')); cleanup.push(async () => disk.close());
  const task = runtime.user.task(graphId);
  // Direct inputs use the same queue. Main waits for integrated implementation work before starting checks.
  await main.graphSend({ graphId, nodeId: 'web-api', input: 'job', value: {} });
  await main.graphSend({ graphId, nodeId: 'web-ui', input: 'job', value: {} });
  await runtime.host.drive();
  await main.graphSend({ graphId, nodeId: 'web-test', input: 'job', value: {} }); await runtime.host.drive();
  expect(JSON.stringify(tester.requests)).toContain('collect_busy');
  expect(JSON.stringify(tester.requests)).toContain('只允许一个采集任务');
  await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  const blocked = await task.view();
  const human = blocked.questions.filter(question => question.kind === 'human_check' && question.status === 'open');
  expect(human).toMatchObject([{ nodeId: '@acceptance/human-login', data: { commitSha: blocked.integrationSha } }]);
  expect(blocked.phase).toBe('blocked');
  const apiTree = blocked.worktrees.find(tree => tree.nodeId === 'web-api');
  const uiTree = blocked.worktrees.find(tree => tree.nodeId === 'web-ui');
  expect(apiTree?.path).toBeTruthy(); expect(uiTree?.path).toBeTruthy(); expect(apiTree!.path).not.toBe(uiTree!.path);
  expect(blocked.nodes.find(node => node.id === 'web-test')?.status).toBe('succeeded');
  expect(blocked.nodes.find(node => node.id === 'review')?.status).toBe('succeeded');
  expect(blocked.nodes.find(node => node.id === 'review')?.instanceId).not.toBe(blocked.nodes.find(node => node.id === 'web-api')?.instanceId);
  const notes = runtime.artifacts.list(graphId, { namespace: 'reviews' }).artifacts.find(item => item.name === 'bilibili-web-notes')!;
  expect((await runtime.artifacts.read(graphId, notes.artifactId, notes.version)).text).toMatch(/结论：pass/);
  await task.answer(human[0]!.id, { type: 'acknowledge' }, 'login'); await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed'); expect(view.targetBranch).toBe('main');
  const acceptance = await main.graphInspect({ graphId, query: 'acceptance' }) as { commit: string; items: { id: string; status: string }[] };
  expect(acceptance.items.map(item => [item.id, item.status])).toEqual([...checks.map(item => [item.id, 'passed']), ['review', 'passed'], ['human-login', 'passed']]);
  expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(acceptance.commit);
  expect(view.nodes.every(node => (node.used ?? 0) > 0)).toBe(true);
  expect(await readFile(join(root, 'src/web-server.js'), 'utf8')).toContain('createWebServer');
  expect(await readFile(join(root, 'src/web/index.html'), 'utf8')).toMatch(/独立 profile/);
  expect(await readFile(join(root, 'test/web-server.test.js'), 'utf8')).toContain('GRAPH_FIXTURE');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  expect(pkg.scripts).toEqual({ ...originalPackage.scripts, web: 'node src/web-server.js' });
  expect(existsSync(join(root, 'tsconfig.json'))).toBe(false);
  expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  expect(git(root, ['log', '-1', '--pretty=%s'])).toMatch(/^graph:/);
  expect(git(source, ['rev-parse', 'HEAD'])).toBe(sourceHead);
  expect(git(source, ['status', '--porcelain'])).toBe(sourceStatus);
  expect(existsSync(join(source, 'src/web-server.js'))).toBe(false);
}, 60_000);
