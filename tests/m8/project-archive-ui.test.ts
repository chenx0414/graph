import { chromium } from 'playwright';

import { expect, test } from 'vitest';

import { cleanup, configFile, session, start, temp } from './settings-ui.fixture.ts';

// 项目归档是一条真实的用户流程：归档后项目从侧栏收起、守护进程拒绝新委派，
// 刷新后仍然是归档态，恢复后回到项目列表。整条流程走真实守护进程、真实
// SQLite 与真实浏览器，不替换任何被测组件。
test('项目归档与恢复在设置里完成，并从侧栏收起', async () => {
  const dir = await temp('project-archive');
  const path = await configFile(dir, 'http://127.0.0.1:1/v1');
  const daemon = await start(dir, path);
  const api = await session(daemon.url);
  const lifecycle = async () => await (await api.get('/api/projects/sample/lifecycle')).json() as { archived: boolean; archivedAt: number | null; state: string };
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const openSettings = async () => {
    await page.goto(`${daemon.url}/#/settings`);
    await page.getByTestId('settings-page').waitFor();
  };

  // 先把项目准备好（状态 ready），再验“已准备的项目不再提供准备按钮”。
  const prepared = await api.post('/api/projects/sample/prepare', { requestId: `prepare-${crypto.randomUUID()}`, initialize: true, createBaseline: true });
  expect(prepared.status).toBeLessThan(400);
  await openSettings();
  // 项目状态是常驻内容，不该藏进折叠区：不点任何折叠控件就必须可见。
  const row = page.getByTestId('git-project-sample');
  await row.waitFor({ state: 'attached' });
  expect(await row.isVisible(), '项目状态被折叠进 details，不展开就看不见').toBe(true);
  expect(await row.getAttribute('data-archived')).toBe('false');
  expect(await page.locator('.settings-project-status .card-sub').count(), '项目卡不该再有副标题说明').toBe(0);
  expect(await row.innerText(), '准备完毕的项目应显示已准备').toContain('已准备');
  expect(await page.getByTestId('git-prepare-sample').count(), '已准备好的项目不该再显示准备 Git 按钮').toBe(0);
  expect(await page.locator('.settings-project-status .card-head').count(), '项目卡不该再有标题行').toBe(0);
  const settings = await (await api.get('/api/settings')).json() as { projects: { id: string; preparation?: { baselineSha?: string } }[] };
  const baselineSha = settings.projects.find(project => project.id === 'sample')?.preparation?.baselineSha ?? '';
  expect(baselineSha.length).toBeGreaterThan(0);
  expect(await row.innerText(), '已准备行不该再显示基线 sha').not.toContain(baselineSha.slice(0, 10));
  expect((await lifecycle()).archived).toBe(false);
  // 归档拒新委派要在一个真实的主管线程上验：同一个请求在归档期间报
  // project_archived，恢复后换成“缺少用户消息”，证明拦住它的是归档本身。
  const thread = await (await api.post('/api/projects/sample/thread', { requestId: `thread-${crypto.randomUUID()}` })).json() as { conversationId: string };
  const createWork = async () => await api.post('/api/orchestration/work', {
    conversationId: thread.conversationId, projectId: 'sample', brief: '归档期间的新委派', acceptance: ['归档的项目不受理'],
    sourceMessageId: 'missing-message', requestId: `work-${crypto.randomUUID()}`,
  });

  await page.getByTestId('project-archive-sample').click();
  await page.getByTestId('project-restore-sample').waitFor();
  expect(await page.getByTestId('git-project-sample').getAttribute('data-archived')).toBe('true');
  expect(await page.getByTestId('archived-projects-label').innerText()).toContain('已归档项目（1）');
  expect(await page.getByTestId('git-prepare-sample').count()).toBe(0);
  expect(await page.getByTestId('git-project-sample').innerText(), '归档行不该再带归档日期与“不再接受新的委派”').not.toMatch(/归档于|不再接受新的委派/);
  expect((await lifecycle()).archived).toBe(true);
  // 归档拒新委派：守护进程不再受理这个项目的新工作。
  const refused = await createWork();
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(await refused.text()).toContain('project_archived');

  // 归档是持久的：重新加载控制台，项目仍在已归档分组里。
  await openSettings();
  await page.getByTestId('project-restore-sample').waitFor();
  expect(await page.getByTestId('git-project-sample').getAttribute('data-archived')).toBe('true');

  // 侧栏只列活跃项目：归档项目整行消失，也没有任何归档提示。
  await page.goto(`${daemon.url}/#/`);
  await page.getByTestId('conversation-list').waitFor();
  expect(await page.getByTestId('archived-projects-hint').count()).toBe(0);
  expect(await page.getByTestId('conversation-list').innerText()).not.toContain('已归档');
  expect(await page.locator('.sidebar-project-name', { hasText: 'sample' }).count()).toBe(0);

  // 恢复：项目回到列表，生命周期重新是活跃。
  await openSettings();
  await page.getByTestId('project-restore-sample').click();
  await page.getByTestId('project-archive-sample').waitFor();
  expect(await page.getByTestId('git-project-sample').getAttribute('data-archived')).toBe('false');
  expect((await lifecycle()).archived).toBe(false);
  // 同一个委派请求在恢复后不再被归档拦住。
  expect(await (await createWork()).text()).toContain('user message');
  await page.goto(`${daemon.url}/#/`);
  await page.getByTestId('conversation-list').waitFor();
  expect(await page.locator('.sidebar-project-name', { hasText: 'sample' }).count()).toBe(1);
}, 180_000);
