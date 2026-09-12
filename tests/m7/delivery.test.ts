import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { mediaBookmarksActions } from './adapters.ts';
import { cloneMediaBookmarks, mediaBookmarksSource } from './clone.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

test('Graph delivers the Bilibili web on an isolated clone and merges after check, review, and human login', async () => {
  const source = mediaBookmarksSource();
  const sourceHead = git(source, ['rev-parse', 'HEAD']);
  const sourceStatus = git(source, ['status', '--porcelain']);
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = cloneMediaBookmarks(join(parent, 'project'), source);
  expect(existsSync(join(root, 'src/cli.js'))).toBe(true);
  expect(existsSync(join(root, 'node_modules'))).toBe(false);
  expect(existsSync(join(root, '.browser-profile'))).toBe(false);
  expect(existsSync(join(root, 'output'))).toBe(false);

  let runtime: Awaited<ReturnType<typeof openTaskRuntime>>;
  runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'media-bookmarks', root }],
    master: { action: 'master', definitionVersion: 'master@1', model: 'scripted' },
    actions: mediaBookmarksActions(() => runtime),
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');

  const { taskId } = await runtime.user.begin({
    projectId: 'media-bookmarks',
    request: '为本机 MediaBookmarks 增加 B站 Web：确认登录、采集、进度与失败原因、浏览收藏和笔记、导出 Markdown。',
    requestId: 'begin',
  });
  const task = runtime.user.task(taskId);
  expect((await task.view()).phase).toBe('discussing');
  await task.say('界面为本机页面；测试数据用 GRAPH_FIXTURE 合成条目；登录在独立 .browser-profile 用 CLI 完成后再确认人工检查项。目标分支 main。', 'discuss');
  await runtime.host.runReady();
  const proposed = await task.view();
  expect(proposed.requirementVersion).toBe(2);
  expect(proposed.proposalVersion).toBe(1);
  expect(proposed.proposal?.acceptance.map(item => item.id)).toEqual([
    'login-status', 'collect-progress', 'browse-notes', 'export-md', 'human-login',
  ]);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const blocked = await task.view();
  expect(blocked.questions).toMatchObject([{ kind: 'human_check', nodeId: 'login' }]);
  expect(blocked.phase).toBe('running');
  const apiTree = blocked.worktrees.find(tree => tree.nodeId === 'web-api');
  const uiTree = blocked.worktrees.find(tree => tree.nodeId === 'web-ui');
  expect(apiTree?.path).toBeTruthy();
  expect(uiTree?.path).toBeTruthy();
  expect(apiTree!.path).not.toBe(uiTree!.path);
  expect(blocked.nodes.find(node => node.id === 'web-test')?.status).toBe('succeeded');
  expect(blocked.nodes.find(node => node.id === 'review')?.status).toBe('succeeded');
  expect(blocked.nodes.find(node => node.id === 'review')?.instanceId).not.toBe(blocked.nodes.find(node => node.id === 'web-api')?.instanceId);

  await task.answer(blocked.questions[0]!.id, { type: 'acknowledge' }, 'login');
  await runtime.host.drive();
  const view = await task.view();
  expect(view.phase).toBe('completed');
  expect(view.targetBranch).toBe('main');
  expect(view.evidence.filter(item => item.valid).map(item => item.acceptanceId).sort()).toEqual([
    'browse-notes', 'collect-progress', 'export-md', 'human-login', 'login-status',
  ]);
  expect(view.nodes.filter(node => node.kind === 'agent').every(node => (node.used ?? 0) > 0)).toBe(true);
  expect(await readFile(join(root, 'src/web-server.js'), 'utf8')).toContain('createWebServer');
  expect(await readFile(join(root, 'src/web/index.html'), 'utf8')).toMatch(/独立 profile/);
  expect(await readFile(join(root, 'test/web-server.test.js'), 'utf8')).toContain('GRAPH_FIXTURE');
  expect(await readFile(join(root, 'docs/bilibili-web-review.md'), 'utf8')).toMatch(/结论：pass/);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts.web).toBe('node src/web-server.js');
  expect(existsSync(join(root, 'tsconfig.json'))).toBe(false);
  expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  expect(git(root, ['log', '-1', '--pretty=%s'])).toMatch(/^graph:/);

  expect(git(source, ['rev-parse', 'HEAD'])).toBe(sourceHead);
  expect(git(source, ['status', '--porcelain'])).toBe(sourceStatus);
  expect(existsSync(join(source, 'src/web-server.js'))).toBe(false);
}, 30_000);
