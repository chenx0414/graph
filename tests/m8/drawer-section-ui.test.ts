/**
 * The drawer's two windows - the draft page and the task navigation - belong to the user, and
 * neither may be yanked away by the other: the "no tasks yet" note lives in the task section, so
 * falling back to the draft page would make it unreachable. The policy only matters if the user
 * can see which window they are in, so this drives the real console in a real browser.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import type { NativeProposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;

beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-drawer-section-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-drawer-section-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A real Git project: confirming a draft requires the target branch to exist. */
function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function gitProject(dir: string) {
  await writeFile(join(dir, 'check.js'), 'console.log("check passed");\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'graph@example.invalid']);
  git(dir, ['config', 'user.name', 'Graph Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function workerCheckProposal(summary: string, requirementVersion = 1): NativeProposal {
  return { requirementVersion, summary, acceptance: [{ id: 'ok', description: '检查通过', checkNode: 'check' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement the requested work', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.js'], output: 'result' } } },
      edges: { checkWork: { from: 'work.result', to: 'check.job', enabled: true } },
      acceptance: [{ id: 'ok', description: '检查通过', kind: 'check', module: 'check' }] }),
  };
}

/** A console with one project, one conversation and a real browser on it. */
async function consoleWith(name: string) {
  const root = await temp(name);
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await gitProject(project);
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'alpha', root: project }], webDir,
    startup: { mode: 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'drawer-section-coder');
  const created = await server.runtime.conversations.create({ projectId: 'alpha', text: '先看看抽屉', requestId: 'create' });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/conversations/${created.conversationId}`);
  await page.getByTestId('drawer-entry').waitFor();
  return { server, page, conversationId: created.conversationId };
}

/** Which of the two windows the drawer is showing right now. */
function section(page: { getByTestId: (id: string) => { getAttribute: (name: string) => Promise<string | null> } }) {
  return page.getByTestId('detail-drawer').getAttribute('data-section');
}

test('a conversation with no task and no draft opens on the task section, where the empty note lives', async () => {
  const { page } = await consoleWith('empty');

  // The drawer starts collapsed, and the chat stream is the conversation itself.
  expect(await page.getByTestId('drawer-entry').getAttribute('data-open')).toBe('false');
  expect(await page.locator('.conversation-thread-inner [data-testid="no-conversation-tasks"]').count()).toBe(0);
  // The collapsed drawer still says what waits inside: no draft, no task yet.
  expect(await page.getByTestId('drawer-entry').getAttribute('aria-label')).toContain('暂无草稿');
  expect(await page.getByTestId('drawer-entry').getAttribute('aria-label')).toContain('任务 0');

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  // The chat column keeps the transcript, the questions and the composer; everything else
  // lives in the drawer, and there is no third home for a panel.
  expect(await page.locator('.conversation-body').getAttribute('data-resident-panels'))
    .toBe('conversation-messages conversation-questions conversation-composer');
  const drawerPanels = (await page.getByTestId('detail-drawer').getAttribute('data-drawer-panels'))!.split(' ');
  for (const panel of ['draft-versions', 'graph', 'artifacts', 'task-nav', 'task', 'task-empty', 'bind-project']) {
    expect(drawerPanels).toContain(panel);
  }
  // There is no draft to show, so the drawer opens on the task section - and it stays there.
  await expect.poll(() => section(page)).toBe('task');
  await page.getByTestId('no-conversation-tasks').waitFor();
  expect(await page.getByTestId('no-conversation-tasks').innerText()).toContain('尚无功能任务');
  // The section that has nothing yet still offers the shared artifacts.
  await page.getByTestId('no-task-graph').waitFor();
  expect(await page.getByTestId('drawer-task-artifacts').count()).toBe(1);

  // The drawer body owns its own scrollbar, so the content never shifts the chat column.
  const scroll = await page.locator('.drawer-inner').evaluate(node => {
    const style = getComputedStyle(node);
    return { overflowY: style.overflowY, scrollbarGutter: style.scrollbarGutter };
  });
  expect(scroll).toEqual({ overflowY: 'auto', scrollbarGutter: 'stable' });
}, 90_000);

test('a live draft opens on the draft page, and it is not yanked away by the task navigation', async () => {
  const { server, page, conversationId } = await consoleWith('draft');
  const anchor = (await server.runtime.conversations.view(conversationId)).anchorTaskId;
  await server.runtime.supervisor(anchor).propose(workerCheckProposal('先做一个最小版本'), 'draft');

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  await page.getByTestId('proposal-draft').waitFor();
  // The draft page is where the user's choice put it, and it stays there.
  await expect.poll(() => section(page)).toBe('draft');
  expect(await page.getByTestId('proposal-draft').innerText()).toContain('先做一个最小版本');
  // The task navigation is still beside it, not instead of it.
  expect(await page.getByTestId('conversation-tasks').count()).toBe(1);
  expect(await page.locator('.conversation-thread-inner [data-testid="proposal-draft"]').count()).toBe(0);
}, 90_000);

test('the chosen task sticks, and the task section is never yanked back to the draft page', async () => {
  const { server, page, conversationId } = await consoleWith('tasks');
  const anchor = (await server.runtime.conversations.view(conversationId)).anchorTaskId;

  await server.runtime.supervisor(anchor).propose(workerCheckProposal('第一个功能'), 'draft-1');
  const first = await server.runtime.conversations.view(conversationId);
  await server.runtime.conversations.confirm(conversationId, {
    proposalVersion: first.proposal!.version, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-1',
  });
  await server.runtime.supervisor(anchor).propose(workerCheckProposal('第二个功能', 2), 'draft-2');
  const second = await server.runtime.conversations.view(conversationId);
  await server.runtime.conversations.confirm(conversationId, {
    proposalVersion: second.proposal!.version, draftRevision: 1, targetBranch: 'main', requestId: 'confirm-2',
  });

  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('detail-drawer').waitFor();
  // Both features are tasks now, and neither of them is a draft any more.
  await expect.poll(() => page.getByTestId('drawer-entry-label').innerText(), { timeout: 30_000 }).toContain('任务 2');
  await expect.poll(() => section(page)).toBe('task');

  const tasks = page.locator('[data-testid^="conversation-task-"]');
  await expect.poll(() => tasks.count()).toBe(2);

  // Nothing is selected yet, so the first task is adopted - the list itself is drawn newest
  // first, so the adopted one is not necessarily the one at the top.
  const listed = (await server.runtime.conversations.view(conversationId)).tasks.map(task => task.id);
  await expect.poll(() => page.locator('[data-testid^="conversation-task-"][data-active="true"]').count()).toBe(1);
  expect(await page.getByTestId(`conversation-task-${listed[0]}`).getAttribute('data-active')).toBe('true');

  // Choosing the other one moves the selection, and the section does not move with it.
  const other = page.locator('[data-testid^="conversation-task-"][data-active="false"]').first();
  const otherId = await other.getAttribute('data-testid');
  await other.click();
  await expect.poll(() => page.getByTestId(otherId!).getAttribute('data-active')).toBe('true');
  expect(await page.getByTestId(`conversation-task-${listed[0]}`).getAttribute('data-active')).toBe('false');
  expect(await section(page)).toBe('task');
  // The chosen task names its own windows.
  await page.getByTestId('drawer-task-detail').waitFor();
  expect(await page.getByTestId('drawer-task-artifacts').count()).toBe(1);
}, 90_000);
