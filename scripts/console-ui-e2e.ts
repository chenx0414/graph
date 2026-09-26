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

async function address(maxMs: number): Promise<string> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const found = /address:\s+(http\S+)/.exec(daemonLog)?.[1];
    if (found) return found.replace(/\/$/, '');
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`守护进程未就绪：\n${daemonLog.slice(-2000)}`);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const url = await address(30_000);
  for (let i = 0; i < 60; i += 1) {
    const health = await fetch(`${url}/api/health`).then(response => response.ok, () => false);
    if (health) break;
    await new Promise(done => setTimeout(done, 250));
  }

  // Seed the rows the tool page reads. Schema-level seeding is deliberate: the page
  // must render what the store holds, not what a test double hands it.
  const db = new DatabaseSync(join(state, 'tasks.sqlite'));
  const seed = db.prepare('INSERT INTO tool_calls(instance_id,task_id,node_id,role,tool,ms,is_error,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const at = Date.now();
  seed.run('inst-e2e', 't-e2e', 'n-e2e', 'master', 'bash', 120, 0, at);
  seed.run('inst-e2e', 't-e2e', 'n-e2e', 'master', 'bash', 300, 1, at);
  seed.run('inst-e2e', 't-e2e', 'n-e2e', 'master', 'agent_browser', 8_000, 0, at);
  db.close();

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
  checkContains('鼠标悬停前的第二行是 agent_browser', rows.join('\n'), 'agent_browser');
  checkContains('agent_browser 平均 8.0 s', rows.join('\n'), '8.0 s');
  checkContains('角色解析为「主 Agent」', rows.join('\n'), '主 Agent');

  const shot = join(screenshots, 'tool-stats.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`截图 ${shot}`);
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
