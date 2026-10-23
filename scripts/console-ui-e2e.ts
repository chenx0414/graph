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
import { TaskStore } from '../src/core/store.ts';
import { openaiServer } from '../tests/fixtures/openai-server.ts';

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
// A skill the seeded read points at: the 技能使用 section must show what the record proves.
await mkdir(join(workspace, '.agents', 'skills', 'e2e-skill'), { recursive: true });
await writeFile(join(workspace, '.agents', 'skills', 'e2e-skill', 'SKILL.md'), '---\nname: e2e-skill\ncreated-by: graph-agent\ndescription: Seeded fixture skill for the console E2E run. Use when the console tool page is asserted.\n---\n');
await mkdir(home, { recursive: true });
// A scripted provider, so this daemon can run one real master turn: the last section proves the
// write the master lane really makes (`pi-adapter` → `recordToolCall`) reaching the page (HB-88).
const provider = await openaiServer([
  { tools: [{ id: 'master-bash', name: 'bash', arguments: JSON.stringify({ command: 'echo master-direct-write' }) }] },
  { text: '记录已写入。' },
  { text: '（余量，防止额外请求把计划用干）' },
]);
const config = join(root, 'graph.config.json');
await writeFile(config, JSON.stringify({
  version: 1,
  projects: [{ id: 'e2e', root: workspace }],
  credentials: { e2e: { secretRef: 'GRAPH_E2E_KEY' } },
  models: { entries: [{ ...provider.model, id: 'e2e-master', credentialId: 'e2e', grade: 'high' }] },
}));

const daemon = spawn(process.execPath, [
  join(repo, 'src', 'server', 'cli.ts'),
  // `--execute` is what lets this daemon dispatch at all (the default is view-only, history and settings
  // only): without it the real turn in the last section never runs and no call of its own is recorded.
  '--execute', '--state-dir', state, '--graph-home', home, '--web-dir', web, '--port', '0', '--config', config,
], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GRAPH_E2E_KEY: 'scripted-local-key' } });
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

  // Seed the rows the tool page reads, through the store's own writer: `recordToolCall` is what the
  // real lane seams call (`pi-adapter`, `kernel-graph-lane`), so the numbers below are the ones the
  // product computes from a real write rather than a hand-inserted row.
  const store = new TaskStore(join(state, 'tasks.sqlite'));
  // The master's own question (ask_user) records kind 'waiting' with requestType
  // 'user_decision' (operation-lifecycle block() + pi-adapter askedQuestion), so the card is
  // seeded with that exact shape rather than a convenient stand-in.
  const task = store.db.prepare('INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq) VALUES(?,?,?,?,?,?,?,?)');
  task.run('hb80-asked', 'e2e', '决策卡片的真浏览器断言', 1, 0, 'running', 0, 2);
  task.run('hb80-empty', 'e2e', '没有待处理问题的任务', 1, 0, 'running', 0, 3);
  store.db.prepare('INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)')
    .run('hb80-asked', 'n-e2e', JSON.stringify({ role: 'master' }), 'inst-e2e');
  store.db.prepare('INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,owner) VALUES(?,?,?,?,?,?,?)').run(
    'q-hb80', 'hb80-asked', 'n-e2e', null, 'waiting',
    JSON.stringify({ requestType: 'user_decision', prompt: '要不要把这条先改成检测？', why: '答案会改变实现' }),
    'user',
  );

  const seeded = [
    { tool: 'bash', ms: 120, isError: false },
    { tool: 'bash', ms: 300, isError: true },
    { tool: 'agent_browser', ms: 8_000, isError: false },
    // One call that touched a skill file: this is what makes the skill show as read.
    { tool: 'read', ms: 4, isError: false, target: join(workspace, '.agents', 'skills', 'e2e-skill', 'SKILL.md') },
  ];
  // The instance id is the node's own, exactly as a lane records it, so the seeded rows are
  // attributed to the master Agent by the same resolution a real call goes through.
  for (const call of seeded) store.recordToolCall({ instanceId: 'inst-e2e', ...call });
  store.db.close();

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
  checkContains('汇总含 4 次调用', summary, '4');
  checkContains('汇总含 1 次失败', summary, '1 次失败');
  checkContains('成功率为 75.0%', summary, '75.0%');
  checkContains('平均耗时为 2.1 s', summary, '2.1 s');
  checkContains('累计耗时 8.4 s', summary, '8.4 s');

  const headers = await page.getByTestId('tool-stats-table').locator('th').allInnerTexts();
  check('表头八列', headers, ['工具', '角色', '次数', '失败', '成功率', '平均耗时', '最大耗时', '最近一次']);
  const rows = await page.getByTestId('tool-stats-table').locator('tbody tr').allInnerTexts();
  check('三行（三个工具）', rows.length, 3);
  checkContains('bash 行：次数/失败/成功率/平均/最大', rows[0] ?? '', 'bash');
  checkContains('bash 行含 2 次', rows[0] ?? '', '2');
  checkContains('bash 行成功率为 50.0%', rows[0] ?? '', '50.0%');
  checkContains('bash 行平均 210 ms', rows[0] ?? '', '210 ms');
  checkContains('bash 行最大 300 ms', rows[0] ?? '', '300 ms');
  checkContains('第二行是 agent_browser（按调用次数排序）', rows[1] ?? '', 'agent_browser');
  checkContains('agent_browser 成功率 100.0%', rows[1] ?? '', '100.0%');
  checkContains('agent_browser 平均 8.0 s', rows[1] ?? '', '8.0 s');
  checkContains('第三行是 read（种子的技能读取）', rows[2] ?? '', 'read');
  checkContains('bash 行角色为「主 Agent」', rows[0] ?? '', '主 Agent');
  check('侧栏「问题」徒标计数为 1', await page.locator('.nav-badge').first().innerText(), '1');

  // 技能使用区块：口径文案必须如实写「只统计被读次数」，且真的按技能给出读数。
  check('技能使用区块存在', await page.getByTestId('skill-usage-summary').count(), 1);
  checkContains('技能区块写明口径', await page.getByTestId('skill-usage-note').innerText(), '不统计技能是否被实际应用');
  const skillCells = await page.getByTestId('skill-usage-row-e2e-skill').locator('td').allInnerTexts();
  check('种子技能的被读次数', skillCells[2], '1');
  check('种子技能的来源', skillCells[1], '项目');

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

  // ── 一次真回合的遥测（HB-88）：上面那段用真实写入路径种下四行，这一段让守护进程自己跑一个回合，
  // 好证明清空之后页面上唯一的那一行来自那个回合，而不是种子。
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'e2e', requestId: 'e2e-master-turn', text: '跑一个回合，好让工具页看见 master 直写的记录。' }),
    });
    const body = await response.json().catch(() => null) as { conversationId?: string } | null;
    return { status: response.status, conversationId: body?.conversationId ?? '' };
  });
  check('控制台 HTTP 面能创建会话（即起一个真回合）', created.status, 200);
  check('创建会话返回了 conversationId', created.conversationId.length > 0, true);

  // The turn is still running when this section starts, so the row it produces only shows up once the
  // lane has written it and this page has read the statistics. Poll the page, not the database: the
  // database is the result of what the page does. And reload rather than goto() - the same URL with a
  // hash does not navigate, which once read as "no telemetry".
  await page.goto(`${url}/#/tools`, { waitUntil: 'domcontentloaded' });
  const telemetryDeadline = Date.now() + 90_000;
  let row = '';
  while (Date.now() < telemetryDeadline && !row) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('tool-stats-table');
    const appeared = await table.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (!appeared) {
      await new Promise(done => setTimeout(done, 1_000));
      continue;
    }
    const rows = await table.locator('tbody tr').allInnerTexts();
    check('清空之后，页面上只有真回合那一行', rows.length, 1);
    if (rows.length === 1) row = rows[0]!;
  }
  checkContains('那行是 bash（真回合真的调了它）', row, 'bash');
  checkContains('角色是「主 Agent」（master 车道）', row, '主 Agent');
  // Read the table back to prove the row is in the store itself, not only in the rendered page.
  const ingested = new DatabaseSync(join(state, 'tasks.sqlite'));
  const stored = ingested.prepare('SELECT tool, role, count(*) AS calls FROM tool_calls GROUP BY tool, role').all() as { tool: string; role: string | null; calls: number }[];
  ingested.close();
  check('真回合之后表里恰好一行：bash / master', stored, [{ tool: 'bash', role: 'master', calls: 1 }]);
  const telemetryShot = join(screenshots, 'tool-stats-real-turn.png');
  await page.screenshot({ path: telemetryShot, fullPage: true });
  console.log(`截图 ${telemetryShot}`);

  check('页面无 JS 错误', problems, []);
} catch (error) {
  failures += 1;
  console.error(`探针自身失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close();
  daemon.kill('SIGTERM');
  await provider.close();
}

console.log(failures === 0 ? '\n真浏览器验收通过' : `\n真浏览器验收失败：${failures} 处`);
process.exit(failures === 0 ? 0 : 1);
