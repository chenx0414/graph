import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { passingReviewAction } from '../fixtures/review-gate.ts';
import { mediaBookmarksActions } from './adapters.ts';
import { cloneMediaBookmarks, mediaBookmarksSource } from './clone.ts';
import type { Proposal } from '../../src/core/types.ts';
import { withLiftedDefinition } from '../fixtures/v2-lift.ts';

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
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-prod-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = cloneMediaBookmarks(join(parent, 'project'), source);
  const server = await readFile(join(payloadDir, 'web-server.js'), 'utf8');
  const page = await readFile(join(payloadDir, 'index.html'), 'utf8');
  const testFile = await readFile(join(payloadDir, 'web-server.test.js'), 'utf8');
  const provider = await openaiServer([
    { tools: [
      { id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'src/web-server.js', content: server }) },
      { id: 'w2', name: 'write', arguments: JSON.stringify({ path: 'src/web/index.html', content: page }) },
      { id: 'w3', name: 'write', arguments: JSON.stringify({ path: 'test/web-server.test.js', content: testFile }) },
    ] },
    { text: 'Wrote the Bilibili web files.' },
  ]);
  cleanup.push(() => provider.close());
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>>;
  const scripted = mediaBookmarksActions(() => runtime);
  runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'media-bookmarks', root }],
    models: {
      entries: [
        { id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 8_192 },
        { id: 'reader', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
      ],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
    },
    actions: { check: scripted.check!, review: passingReviewAction },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
  const { taskId } = await runtime.user.begin({
    projectId: 'media-bookmarks',
    request: '为本机 MediaBookmarks 增加 B站 Web：确认登录、采集、进度与失败原因、浏览收藏和笔记、导出 Markdown。',
    requestId: 'begin',
  });
  const proposed = await runtime.supervisor(taskId).propose(withLiftedDefinition({
    requirementVersion: 1,
    summary: '本机 Web 复用 CLI：B站登录态、采集进度与失败原因、收藏与笔记、Markdown 导出。采集使用项目内 .browser-profile，禁止并发采集，不共享日常 Chrome。',
    acceptance: [
      { id: 'login-status', description: '页面展示 B站登录态，并标明独立 profile 与不可并发采集', checkNode: 'check' },
      { id: 'collect-progress', description: '可发起采集并看到进度与失败原因', checkNode: 'check' },
      { id: 'browse-notes', description: '可浏览收藏条目与已有 Markdown 笔记', checkNode: 'check' },
      { id: 'export-md', description: '可导出 Markdown 并得到非空结果', checkNode: 'check' },
      { id: 'human-login', description: '使用者在独立 profile 完成 B站登录后确认', checkNode: 'login' },
    ],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
      { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'reader', dependsOn: ['check'] },
      { id: 'review-gate', kind: 'program', action: 'graph.verify', dependsOn: ['review'], verifier: { kind: 'independent', reportNodes: ['review'] } },
      { id: 'login', kind: 'program', action: 'graph.human_check', dependsOn: ['review-gate'] },
    ],
  } as Proposal), 'm7-prod-plan');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const blocked = await task.view();
  expect(blocked.questions).toMatchObject([{ kind: 'human_check', nodeId: 'login' }]);
  expect(provider.requests.length).toBeGreaterThan(0);
  expect((provider.requests[0] as { tools?: unknown[] }).tools?.length).toBeGreaterThan(0);
  await task.answer(blocked.questions[0]!.id, { type: 'acknowledge' }, 'login');
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(await readFile(join(root, 'src/web-server.js'), 'utf8')).toContain('not_logged_in');
  expect(await readFile(join(root, 'src/web/index.html'), 'utf8')).toContain('note-body');
  expect(existsSync(join(root, 'test/web-server.test.js'))).toBe(true);
  expect(git(source, ['rev-parse', 'HEAD'])).toBe(sourceHead);
}, 30_000);
