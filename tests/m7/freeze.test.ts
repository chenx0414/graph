import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

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

  const summary = '本机 Web 复用 CLI：B站登录态、采集进度与失败原因、收藏与笔记、Markdown 导出。采集使用项目内 .browser-profile，禁止并发采集，不共享日常 Chrome。登录由使用者在 CLI 完成后再确认人工检查项。';
  const checks = [
    { id: 'login-status', description: '页面展示 B站登录态，并标明独立 profile 与不可并发采集' },
    { id: 'collect-progress', description: '可发起采集并看到进度与失败原因' },
    { id: 'browse-notes', description: '可浏览收藏条目与已有 Markdown 笔记' },
    { id: 'export-md', description: '可导出 Markdown 并得到非空结果' },
  ];
  const worker = (task: string) => ({ recipe: 'coder@1', task, inputs: { job: { protocol: 'data' } }, outputs: { done: { protocol: 'data' } }, submission: { required: ['done'] } });
  const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Frozen Bilibili web', protocols: { data: { type: 'object' } },
    nodes: {
      'web-api': worker('实现 Web API，采用独立 .browser-profile 并禁止并发采集'),
      'web-ui': worker('实现本机界面，明确不共享日常 Chrome'),
      'web-test': worker('验证登录、采集、收藏与笔记、Markdown 导出'),
      review: { recipe: 'reviewer@1', task: '独立审查已发布实现版本', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
    },
    modules: {
      join: { type: 'router', trigger: 'once', requiredInputs: ['api', 'ui'], inputs: { api: { protocol: 'data' }, ui: { protocol: 'data' } }, outputs: { ready: { protocol: 'data' } },
        rules: [{ when: '$exists(api) && $exists(ui)', emit: { ready: { api: '$api', ui: '$ui' } } }] },
      check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--test', 'test/web-server.test.js'], output: 'result' } },
    },
    edges: {
      api: { from: 'web-api.done', to: 'join.api', enabled: true }, ui: { from: 'web-ui.done', to: 'join.ui', enabled: true },
      joined: { from: 'join.ready', to: 'web-test.job', enabled: true }, tested: { from: 'web-test.done', to: 'check.job', enabled: true }, checked: { from: 'check.result', to: 'review.job', enabled: true },
    },
    inputs: { api: { to: 'web-api.job', protocol: 'data' }, ui: { to: 'web-ui.job', protocol: 'data' } },
    acceptance: [...checks.map(item => ({ ...item, kind: 'check', module: 'check' })),
      { id: 'review', description: 'Independent review of this commit', kind: 'review', node: 'review' },
      { id: 'human-login', description: '使用者在独立 profile 完成 B站登录后确认', kind: 'human' }],
  });
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
          await runtime.supervisor(operation.taskId).propose({ requirementVersion: operation.requirementVersion, summary, definition,
            acceptance: definition.acceptance!.map(item => ({ id: item.id, description: item.description, checkNode: item.kind === 'check' ? 'check' : 'review' })),
          }, 'm7-plan');
          return { outcome: 'completed', output: { planned: true }, usage };
        },
      },
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');

  const { taskId, conversationId } = await runtime.conversations.create({
    projectId: 'media-bookmarks',
    text: '为本机 MediaBookmarks 增加 B站 Web。',
    requestId: 'begin',
  });
  const task = runtime.user.task(taskId);
  await task.say('独立 .browser-profile，禁止并发采集，不共享日常 Chrome。登录走 CLI 后人工确认。', 'discuss');
  await runtime.host.runReady();
  const view = await task.view();
  expect(view.phase).toBe('chatting');
  expect(view.requirementVersion).toBe(2);
  expect(view.proposal?.acceptance.map(item => item.id)).toEqual([
    'login-status', 'collect-progress', 'browse-notes', 'export-md', 'review', 'human-login',
  ]);
  expect(view.proposal?.summary).toMatch(/\.browser-profile/);
  expect(view.proposal?.summary).toMatch(/禁止并发采集/);
  expect(view.proposal?.summary).toMatch(/不共享日常 Chrome/);
  expect(view.proposal?.definition?.acceptance?.find(item => item.id === 'human-login')).toMatchObject({ kind: 'human' });
  expect(view.proposal?.definition?.nodes.master).toBeUndefined();
  expect(view.proposal?.definition?.inputs).toEqual({ api: { to: 'web-api.job', protocol: 'data' }, ui: { to: 'web-ui.job', protocol: 'data' } });
  expect(view.proposal?.definition?.modules.join).toMatchObject({ trigger: 'once', requiredInputs: ['api', 'ui'] });
  expect(view.proposal?.definition?.nodes.review?.recipe).toBe('reviewer@1');
  const receipt = await runtime.conversations.confirm(conversationId, { proposalVersion: view.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  expect(receipt.taskId).not.toBe(taskId);
  const confirmed = await runtime.user.task(receipt.taskId).view();
  expect(confirmed.targetBranch).toBe('main');
  expect(confirmed.nodes.map(node => node.id).sort()).toEqual(['review', 'web-api', 'web-test', 'web-ui']);
  expect(confirmed.nodes.every(node => node.status === 'idle')).toBe(true);
  expect(await runtime.supervisor(taskId).graphInspect({ graphId: receipt.taskId, query: 'queue' })).toMatchObject({ items: [] });
  expect((await runtime.conversations.view(conversationId)).tasks.map(task => task.id)).toEqual([receipt.taskId]);
});
