/**
 * Real-browser acceptance for a console page.
 *
 * Run: node --run e2e:console   (build the bundle first: node --run build:web)
 *
 * A page that only exists in the browser - a data table with computed numbers, a
 * card that appears when the server is waiting on a person - cannot be proven by
 * a jsdom render of a component with props. This boots a throwaway daemon, seeds
 * the rows the page reads, drives the real bundle in Chromium through playwright,
 * asserts the rendered DOM and exits non-zero on any mismatch.
 *
 * Isolation: state dir, graph home, project root and port are all throwaway, and
 * the port is chosen by the daemon itself. It never touches the production state
 * directory or ~/.graph. A screenshot of each page is left in
 * `<tmp>/graph-console-e2e-screens/` for the reviewer.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { readConsoleAddress } from '../src/server/console-address.ts';
import { TOOL_CALL_SPOOL_DIR, toolCallSpoolPath } from '../src/runtime/tool-call-spool.ts';

const repo = join(import.meta.dirname, '..');
const web = join(repo, 'dist', 'web');
if (!existsSync(web)) {
  console.error('缺少构建产物：先跑 node --run build:web');
  process.exit(1);
}

const screenshots = join(tmpdir(), 'graph-console-e2e-screens');
await mkdir(screenshots, { recursive: true });

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       实际=${JSON.stringify(actual)}\n       期望=${JSON.stringify(expected)}`}`);
}
function checkContains(name: string, haystack: string, needle: string) {
  const ok = haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       在 ${JSON.stringify(haystack.slice(0, 200))} 中找不到 ${JSON.stringify(needle)}`}`);
}

const root = await mkdtemp(join(tmpdir(), 'graph-console-e2e-'));
const state = join(root, 'state');
const home = join(root, 'graph-home');
const workspace = join(root, 'project');
await mkdir(workspace, { recursive: true });
await mkdir(home, { recursive: true });
const config = join(root, 'graph.config.json');
await writeFile(config, JSON.stringify({ version: 1, projects: [{ id: 'e2e', root: workspace }] }));

const daemon = spawn(process.execPath, [
  join(repo, 'src', 'server', 'cli.ts'),
  '--state-dir', state, '--graph-home', home, '--web-dir', web, '--port', '0', '--config', config,
], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
let daemonLog = '';
daemon.stdout.on('data', (chunk: Buffer) => { daemonLog += String(chunk); });
daemon.stderr.on('data', (chunk: Buffer) => { daemonLog += String(chunk); });

// The address comes from the record the daemon publishes, not from scraping its stdout: reading it
// here is also what proves the record works for a tool that did not start the daemon.
async function address(maxMs: number): Promise<string> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const record = await readConsoleAddress(state);
    if (record) return record.url.replace(/\/$/, '');
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`守护进程未就绪（${state} 下无可用 console.json）：\n${daemonLog.slice(-2000)}`);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const url = await address(30_000);
  for (let i = 0; i < 60; i += 1) {
    const health = await fetch(`${url}/api/health`).then(response => response.ok, () => false);
    if (health) break;
    await new Promise(done => setTimeout(done, 250));
  }

  // Seed through the worker spool, not by inserting rows: the page must show what the new
  // ingest path produces, and a worker lane is the only writer that uses it.
  const db = new DatabaseSync(join(state, 'tasks.sqlite'));
  // The master's own question (ask_user) records kind 'waiting' with requestType
  // 'user_decision' (operation-lifecycle block() + pi-adapter askedQuestion), so the card is
  // seeded with that exact shape rather than a convenient stand-in.
  const task = db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES(?,?,?,?,?,?,?,?)');
  task.run('hb80-asked', 'e2e', '决策卡片的真浏览器断言', 1, 0, 'running', 0, 2);
  task.run('hb80-empty', 'e2e', '没有待处理问题的任务', 1, 0, 'running', 0, 3);
  db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)')
    .run('hb80-asked', 'n-e2e', JSON.stringify({ role: 'master' }), 'inst-e2e');
  db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,owner) VALUES(?,?,?,?,?,?,?)').run(
    'q-hb80', 'hb80-asked', 'n-e2e', null, 'waiting',
    JSON.stringify({ requestType: 'user_decision', prompt: '要不要把这条先改成检测？', why: '答案会改变实现' }),
    'user',
  );
  db.close();

  const spooled = [
    { tool: 'bash', ms: 120, isError: false },
    { tool: 'bash', ms: 300, isError: true },
    { tool: 'agent_browser', ms: 8_000, isError: false },
  ];
  await mkdir(join(state, TOOL_CALL_SPOOL_DIR), { recursive: true });
  await writeFile(
    toolCallSpoolPath(state, 'inst-e2e'),
    spooled.map(call => `${JSON.stringify({ instanceId: 'inst-e2e', ...call, at: Date.now() })}\n`).join(''),
  );

  browser = await chromium.launch();
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });

  await page.goto(`${url}/#/tools`, { waitUntil: 'domcontentloaded' });
  const pageRoot = page.getByTestId('tool-stats-page');
  try {
    await pageRoot.waitFor({ timeout: 10_000 });
  } catch {
    await page.getByRole('button', { name: '工具' }).first().click();
    await pageRoot.waitFor({ timeout: 10_000 });
  }
  await page.getByTestId('tool-stats-table').waitFor({ timeout: 10_000 });

  check('页面根节点存在', await pageRoot.count(), 1);
  const summary = await page.getByTestId('tool-stats-summary').innerText();
  checkContains('汇总含「调用次数」', summary, '调用次数');
  checkContains('汇总含 3 次调用', summary, '3');
  checkContains('汇总含 1 次失败', summary, '1 次失败');
  checkContains('成功率为 66.7%', summary, '66.7%');
  checkContains('平均耗时为 2.8 s', summary, '2.8 s');
  checkContains('累计耗时 8.4 s', summary, '8.4 s');

  const headers = await page.getByTestId('tool-stats-table').locator('th').allInnerTexts();
  check('表头八列', headers, ['工具', '角色', '次数', '失败', '成功率', '平均耗时', '最大耗时', '最近一次']);
  const rows = await page.getByTestId('tool-stats-table').locator('tbody tr').allInnerTexts();
  check('两行（两个工具）', rows.length, 2);
  checkContains('bash 行：次数/失败/成功率/平均/最大', rows[0] ?? '', 'bash');
  checkContains('bash 行含 2 次', rows[0] ?? '', '2');
  checkContains('bash 行成功率为 50.0%', rows[0] ?? '', '50.0%');
  checkContains('bash 行平均 210 ms', rows[0] ?? '', '210 ms');
  checkContains('bash 行最大 300 ms', rows[0] ?? '', '300 ms');
  checkContains('第二行是 agent_browser（按调用次数排序）', rows[1] ?? '', 'agent_browser');
  checkContains('agent_browser 成功率 100.0%', rows[1] ?? '', '100.0%');
  checkContains('agent_browser 平均 8.0 s', rows[1] ?? '', '8.0 s');
  checkContains('bash 行角色为「主 Agent」', rows[0] ?? '', '主 Agent');
  check('侧栏「问题」徒标计数为 1', await page.locator('.nav-badge').first().innerText(), '1');

  const shot = join(screenshots, 'tool-stats.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`截图 ${shot}`);
  // 清空记录：先证明接口真的归零，再分开断言「页面不刷新就回到空态」——这两件事不是一回事，
  // 合在一句里会把「接口没清」与「界面没重渲染」当成同一个失败（HB-90）。
  // 「清空记录」先弹原生 confirm：不接手的话弹框行为由浏览器默认决定，断言就不确定。
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: '清空记录' }).click();
  // 同一刻读两件事：接口的结果与 DOM 的实际状态。它们不一致就是「界面没跟上」，不是接口问题。
  await page.waitForFunction(() => !document.querySelector('[data-testid="tool-stats-table"]')
    || document.body.innerText.includes('还没有记录'), undefined, { timeout: 10_000 }).then(() => true, () => false);
  const after = await page.evaluate(async () => {
    const body = await fetch('/api/tool-stats', { cache: 'no-store' }).then(response => response.json()) as { stats?: unknown[] };
    return {
      apiRows: Array.isArray(body.stats) ? body.stats.length : -1,
      domHasTable: Boolean(document.querySelector('[data-testid="tool-stats-table"]')),
      domMentionsEmpty: document.body.innerText.includes('还没有记录'),
    };
  });
  check('清空后接口返回 0 行', after.apiRows, 0);
  console.log(`       同一刻 DOM：仍有表格=${after.domHasTable}，已显示空态=${after.domMentionsEmpty}`);
  check('清空后 DOM 不再有表格', after.domHasTable, false);

  // 口径文案只在空态渲染：用 reload 而不是 goto（同一个带 hash 的 URL 不会触发导航）。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('tool-stats-page').getByText('还没有记录').waitFor({ timeout: 10_000 });
  const cleared = await page.getByTestId('tool-stats-page').innerText();
  checkContains('口径说明写明含并行车道', cleared, '并行车道');
  check('清空后表格消失', await page.getByTestId('tool-stats-table').count(), 0);

  // The decision card: the shape the master's own ask_user question renders as.
  await page.goto(`${url}/#/tasks/hb80-asked`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('questions').waitFor({ timeout: 10_000 });
  check('待处理问题列表有一张卡', await page.getByTestId('questions').locator('li').count(), 1);
  const card = await page.getByTestId('questions').innerText();
  checkContains('卡片显示问题原文', card, '要不要把这条先改成检测？');
  checkContains('卡片标出 waiting 类型', card, 'waiting');
  checkContains('卡片显示提问原因', card, '答案会改变实现');
  check('决定输入框的提示语', await page.getByTestId('waiting-value').getAttribute('placeholder'), '写下你的决定');
  await page.getByText('查看技术详情').first().click();
  check('技术详情展开后可见', await page.getByTestId('question-data-q-hb80').isVisible(), true);
  checkContains('技术详情含 user_decision', await page.getByTestId('question-data-q-hb80').innerText(), 'user_decision');
  const cardShot = join(screenshots, 'question-card.png');
  await page.screenshot({ path: cardShot, fullPage: true });
  console.log(`截图 ${cardShot}`);

  await page.goto(`${url}/#/tasks/hb80-empty`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('no-questions').waitFor({ timeout: 10_000 });
  check('无问题的任务显示空态', await page.getByTestId('no-questions').count(), 1);

  check('页面无 JS 错误', problems, []);
} catch (error) {
  failures += 1;
  console.error(`探针自身失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close();
  daemon.kill('SIGTERM');
}

console.log(failures === 0 ? '\n真浏览器验收通过' : `\n真浏览器验收失败：${failures} 处`);
process.exit(failures === 0 ? 0 : 1);
