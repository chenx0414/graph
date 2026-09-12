import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { mediaBookmarksProposal } from './proposal.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

test('G17 freezes Bilibili web acceptance, exclusive profile, and a human login check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m7-freeze-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'media-bookmarks\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);

  let runtime: Awaited<ReturnType<typeof openTaskRuntime>>;
  runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'media-bookmarks', root }],
    master: { action: 'master', definitionVersion: 'master@1', model: 'scripted' },
    actions: {
      master: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async operation => async () => {
          await runtime.supervisor(operation.taskId).propose(mediaBookmarksProposal(operation.requirementVersion), 'm7-plan');
          return { outcome: 'completed', output: { planned: true }, usage };
        },
      },
    },
  });
  cleanup.push(() => runtime.close());

  const { taskId } = await runtime.user.begin({
    projectId: 'media-bookmarks',
    request: '为本机 MediaBookmarks 增加 B站 Web。',
    requestId: 'begin',
  });
  const task = runtime.user.task(taskId);
  await task.say('独立 .browser-profile，禁止并发采集，不共享日常 Chrome。登录走 CLI 后人工确认。', 'discuss');
  await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('discussing');
  expect(view.requirementVersion).toBe(2);
  expect(view.proposal?.acceptance.map(item => item.id)).toEqual([
    'login-status', 'collect-progress', 'browse-notes', 'export-md', 'human-login',
  ]);
  expect(view.proposal?.summary).toMatch(/\.browser-profile/);
  expect(view.proposal?.summary).toMatch(/禁止并发采集/);
  expect(view.proposal?.summary).toMatch(/不共享日常 Chrome/);
  expect(view.proposal?.nodes.find(node => node.id === 'login')).toMatchObject({ kind: 'program', action: 'graph.human_check' });
  expect(view.proposal?.nodes.find(node => node.id === 'web-api')?.dependsOn).toEqual(['master']);
  expect(view.proposal?.nodes.find(node => node.id === 'web-ui')?.dependsOn).toEqual(['master']);
  expect(view.proposal?.nodes.find(node => node.id === 'review')?.definitionVersion).toBe('reviewer@1');
  await task.accept({ proposalVersion: view.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect((await task.view()).targetBranch).toBe('main');
});
