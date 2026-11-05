#!/usr/bin/env node
/**
 * One fold policy, three chat windows, measured in a real browser.
 *
 * The policy under measurement: a turn block opens by default, and the tool
 * groups inside a turn start folded — the settled turn and the turn that is
 * still running alike. This script seeds the records the runtime writes (the
 * message table and the node entry table), starts the real daemon on the bundle
 * this checkout built, and reads the rendered DOM of the main conversation, a
 * project supervisor conversation and a node conversation:
 *
 *   - every .tool-activity-group has data-open="false" and its
 *     .tool-group-content has height 0 (a group that claims to be folded must
 *     not reserve space for its detail);
 *   - every turn block (.collapsed-turn) has data-open="true";
 *   - clicking a group opens it (height > 0) and clicking again folds it back.
 *
 * Each window is measured after its own rows are scrolled into view: the
 * transcript sets `content-visibility: auto` on offscreen rows, so a geometry
 * read of a row that was never laid out would report 0px for the wrong reason.
 *
 * Any assertion failing exits non-zero: the artifact is the run, not a claim.
 *
 * The browser is host-owned. A shell inside Graph's sandbox cannot launch a
 * browser of its own (chromium dies of SEGV_ACCERR, firefox with
 * "sandbox_extension_issue_file_to_process failed"), so the browser is started
 * once as a host app with a DevTools endpoint and this script drives it:
 *
 *   desktop launch Electron --arg=/tmp/fold-electron --cdp 9333
 *   GRAPH_FOLD_CDP=http://127.0.0.1:9333 node scripts/measure-fold-policy.mjs
 *
 * On a host that can launch a browser itself, one command is enough:
 *
 *   node scripts/measure-fold-policy.mjs --executable <path to a working chromium>
 *
 * Flags: --cdp <url> | --executable <path> | --web-dir <dir> | --out <dir> |
 *        --label <name> | --keep.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The browser this run measures with when the caller named none. */
// A measurement nobody can start is a measurement nobody runs: the gate command
// carries no flags, so the common case has to work with none. The list is
// ordered by what this machine actually has; a host that can launch a browser
// itself still wins over connectOverCDP, because a launched browser needs no
// endpoint passed in.
function detectBrowserExecutable() {
  const candidates = [
    process.env.GRAPH_FOLD_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    join(homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

function flag(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const outDir = resolve(String(flag('out', join(repo, 'deliverables/e2e-evidence/fold-policy'))));
const webDir = resolve(String(flag('web-dir', join(repo, 'dist/web'))));
const cdpEndpoint = process.env.GRAPH_FOLD_CDP || (typeof flag('cdp') === 'string' ? flag('cdp') : undefined);
const executable = typeof flag('executable') === 'string' ? flag('executable') : detectBrowserExecutable();
const keep = flag('keep', false) === true;
const label = typeof flag('label') === 'string' ? flag('label') : 'run';

function fail(message) {
  throw new Error(message);
}

/** The built bundle this run measures: a stale build is the first thing to rule out. */
async function describeBundle() {
  const indexPath = join(webDir, 'index.html');
  if (!existsSync(indexPath)) fail(`${indexPath} is missing — run node --run build:web first`);
  const html = await readFile(indexPath, 'utf8');
  const asset = /<script[^>]+src="\/?(assets\/[^"]+)"/.exec(html)?.[1] ?? '(no bundle script tag)';
  const info = await stat(join(webDir, asset)).catch(() => null);
  return { asset, path: join(webDir, asset), builtAt: info ? new Date(info.mtimeMs).toISOString() : 'unknown', bytes: info?.size ?? 0 };
}

/** The daemon binary: a worktree build may not exist, so fall back to the
 * checkout the worktree belongs to (its `git` common dir). */
function findDaemon() {
  const candidates = [process.env.GRAPH_DAEMON_BIN, join(repo, 'dist/graphd')].filter(Boolean);
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
    candidates.push(join(dirname(commonDir), 'dist/graphd'));
  } catch {
    // Not a git worktree: the explicit candidates are all that is left.
  }
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) fail('no graphd binary: run node --run build:backend or set GRAPH_DAEMON_BIN');
  return found;
}

async function startDaemon(root) {
  const bin = findDaemon();
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# project\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  for (const args of [['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    execFileSync('git', args, { cwd: project });
  }
  const config = join(root, 'graph.config.json');
  await writeFile(config, JSON.stringify({
    version: 1,
    projects: [{ id: 'alpha', root: project }],
    credentials: { local: { secretRef: 'GRAPH_FOLD_KEY' } },
    models: { entries: [{ id: 'local', provider: 'stub', grade: 'medium', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] },
  }, null, 2));
  const child = spawn(bin, ['--state-dir', join(root, 'state'), '--graph-home', join(root, 'home'), '--web-dir', webDir, '--port', '0', '--config', config], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root, GRAPH_FOLD_KEY: 'synthetic-fold-key' },
  });
  let banner = '';
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not start within 30s\n${banner}`)), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { banner += chunk; });
    child.stdout.on('data', chunk => {
      banner += chunk;
      const address = /address:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(banner);
      if (address) { clearTimeout(timer); resolveUrl(address[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`daemon exited before startup (${code})\n${banner}`)); });
  });
  const home = await fetch(url);
  const cookie = home.headers.get('set-cookie') ?? '';
  const call = async (path, init = {}) => {
    const response = await fetch(url + path, { ...init, headers: { origin: url, cookie, 'content-type': 'application/json', ...init.headers } });
    const body = await response.json().catch(() => null);
    if (!response.ok) fail(`${init.method ?? 'GET'} ${path} -> ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
  return { bin, url, child, call, stop: () => child.kill('SIGTERM') };
}

/** The records the runtime writes for one conversation: a settled turn with its
 * tool work and answer, then a turn whose work is still in flight. */
function seedConversation(db, conversationId, turn, title) {
  const stamp = Date.now() - 60_000 + turn * 10_000;
  const insert = db.prepare('INSERT INTO messages(id,conversation_id,role,kind,text,data,state,operation_id,turn,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)');
  const settled = `op-${turn}-settled`;
  const live = `op-${turn}-live`;
  insert.run(`${turn}-u1`, conversationId, 'user', 'chat', `${title}：先把仓库跑起来`, null, 'done', settled, stamp, stamp);
  insert.run(`${turn}-t1`, conversationId, 'tool', 'tool', 'bash: npm test', JSON.stringify({ toolCallId: `call-${turn}-a`, toolName: 'run_command' }), 'done', settled, stamp + 1, stamp + 1);
  insert.run(`${turn}-t2`, conversationId, 'tool', 'tool', 'read src/index.ts', JSON.stringify({ toolCallId: `call-${turn}-b`, toolName: 'read' }), 'done', settled, stamp + 2, stamp + 2);
  insert.run(`${turn}-a1`, conversationId, 'assistant', 'chat', '测试跑完了，全部通过。', null, 'done', settled, stamp + 3, stamp + 3);
  insert.run(`${turn}-u2`, conversationId, 'user', 'chat', '再跑一次带覆盖率的', null, 'done', live, stamp + 4, stamp + 4);
  insert.run(`${turn}-t3`, conversationId, 'tool', 'tool', 'bash: npm run coverage', JSON.stringify({ toolCallId: `call-${turn}-c`, toolName: 'run_command' }), 'pending', live, stamp + 5, stamp + 5);
}

function seedNode(db, taskId) {
  const insert = db.prepare('INSERT INTO node_entries(id,task_id,node_id,operation_id,role,kind,text,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const stamp = Date.now() - 40_000;
  const settled = 'op-node-settled';
  const live = 'op-node-live';
  insert.run('node-u1', taskId, 'master', settled, 'user', 'chat', '把测试补齐', null, stamp);
  insert.run('node-t1', taskId, 'master', settled, 'tool', 'tool', 'bash: npm test', JSON.stringify({ toolCallId: 'call-node-a', toolName: 'run_command' }), stamp + 1);
  insert.run('node-a1', taskId, 'master', settled, 'assistant', 'chat', '补齐了三个用例。', null, stamp + 2);
  insert.run('node-u2', taskId, 'master', live, 'user', 'chat', '再补一个边界用例', null, stamp + 3);
  insert.run('node-t2', taskId, 'master', live, 'tool', 'tool', 'read tests/index.test.ts', JSON.stringify({ toolCallId: 'call-node-b', toolName: 'read' }), stamp + 4);
}

const READ_GROUP = node => ({
  open: node.getAttribute('data-open'),
  height: node.querySelector('.tool-group-content')?.getBoundingClientRect().height ?? -1,
  label: node.querySelector('.tool-group-copy strong')?.textContent ?? '',
  laidOut: node.getBoundingClientRect().height,
});

const READ_TURN = node => ({ open: node.getAttribute('data-open'), label: node.textContent?.slice(0, 30) ?? '' });

const STEP_MS = 100;

/** Read until the check passes, or fail with the last reading. A CSS fold is a
 * transition: the attribute flips first and the height follows. */
async function poll(read, check, describe, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (Date.now() < deadline) {
    last = await read();
    if (check(last)) return last;
    await new Promise(done => setTimeout(done, STEP_MS));
  }
  fail(`${describe} within ${budgetMs}ms; last reading ${JSON.stringify(last)}`);
}

async function measureWindow(page, target, outDir, label) {
  const problems = [];
  await page.goto(target.url, { waitUntil: 'domcontentloaded' });
  const groups = page.locator('[data-testid="tool-activity-group"]:visible');
  const turns = page.locator('[data-testid="collapsed-turn"]:visible');

  // The settled turn and the in-flight turn both have to be on screen before the
  // first paint is judged; the shell opens history whole, so this is bounded.
  await poll(async () => ({ groups: await groups.count(), turns: await turns.count() }),
    count => count.groups >= 2, 'the settled and in-flight tool groups to render', 60_000);
  const counts = { groups: await groups.count(), turns: await turns.count() };
  if (counts.turns < 1) problems.push('no turn block (.collapsed-turn) rendered for the settled turn');

  // Scroll each row into view before reading it: offscreen rows are laid out
  // lazily (`content-visibility: auto`) and would report 0px for the wrong reason.
  const groupReadings = [];
  for (let index = 0; index < counts.groups; index += 1) {
    const group = groups.nth(index);
    await group.scrollIntoViewIfNeeded();
    const reading = await poll(() => group.evaluate(READ_GROUP), value => value.laidOut > 0, `group ${index} to lay out`);
    groupReadings.push(reading);
    if (reading.open !== 'false') problems.push(`group ${index} ("${reading.label}") renders data-open=${reading.open}, expected false`);
    if (reading.height !== 0) problems.push(`group ${index} ("${reading.label}") reserves ${reading.height}px of detail while folded, expected 0`);
  }
  const turnReadings = [];
  for (let index = 0; index < counts.turns; index += 1) {
    const turn = turns.nth(index);
    await turn.scrollIntoViewIfNeeded();
    const reading = await poll(() => turn.evaluate(READ_TURN), value => value.open !== null, `turn ${index} to render`);
    turnReadings.push(reading);
    if (reading.open !== 'true') problems.push(`turn ${index} ("${reading.label}") renders data-open=${reading.open}, expected true`);
  }

  const shot = join(outDir, `${label}-${target.key}.png`);
  await page.screenshot({ path: shot });

  // The fold is a default, not a permanent state: one click opens the group,
  // a second click folds it back to no height.
  const firstGroup = groups.first();
  await firstGroup.scrollIntoViewIfNeeded();
  await firstGroup.locator('.tool-group-toggle').click();
  const opened = await poll(() => firstGroup.evaluate(READ_GROUP), value => value.open === 'true' && value.height > 0, 'the clicked group to open with height');
  const openedShot = join(outDir, `${label}-${target.key}-opened.png`);
  await page.screenshot({ path: openedShot });
  await firstGroup.locator('.tool-group-toggle').click();
  const folded = await poll(() => firstGroup.evaluate(READ_GROUP), value => value.open === 'false' && value.height === 0, 'the clicked group to fold back to no height');

  return {
    key: target.key, name: target.name, url: target.url,
    counts, groups: groupReadings, turns: turnReadings, opened, folded,
    problems, shots: [shot, openedShot],
  };
}

async function main() {
  const bundle = await describeBundle();
  console.log(`bundle: ${bundle.asset} (${bundle.bytes} bytes, built ${bundle.builtAt})`);
  console.log(`web dir: ${webDir}`);
  await mkdir(outDir, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), 'graph-fold-policy-'));
  const report = { label, bundle, measuredAt: new Date().toISOString(), windows: [], ok: false };
  let daemon;
  let browser;
  let launchedHere = false;
  try {
    daemon = await startDaemon(root);
    console.log(`daemon: ${daemon.bin}\n  ${daemon.url}`);

    const global = await daemon.call('/api/orchestration/global', { method: 'POST', body: JSON.stringify({ requestId: 'fold-global' }) });
    const supervisor = await daemon.call('/api/projects/alpha/thread', { method: 'POST', body: JSON.stringify({ requestId: 'fold-project' }) });
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
    db.exec('PRAGMA busy_timeout=5000');
    seedConversation(db, global.conversationId, 1, '主对话');
    seedConversation(db, supervisor.conversationId, 2, '主管对话');
    seedNode(db, global.taskId);
    db.close();
    console.log(`seeded: main ${global.conversationId}, supervisor ${supervisor.conversationId}, node master of ${global.taskId}`);

    const { chromium } = await import('playwright');
    if (cdpEndpoint) {
      browser = await chromium.connectOverCDP(cdpEndpoint);
      console.log(`browser: ${cdpEndpoint} (host-launched, ${browser.version()})`);
    } else {
      if (!executable) fail('no browser: pass --cdp <endpoint> for a host-launched browser, or --executable <path>');
      browser = await chromium.launch({ headless: true, executablePath: executable });
      launchedHere = true;
      console.log(`browser: ${executable} (${browser.version()})`);
    }
    report.browser = { version: browser.version(), cdp: cdpEndpoint ?? null, executable: executable ?? null };

    // A host-launched Electron window owns one page and refuses
    // Target.createTarget, so all three windows are measured in that one page:
    // the same window the reader uses, one route at a time.
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1440, height: 960 }).catch(() => undefined);

    const targets = [
      { key: 'main', name: '主对话', url: `${daemon.url}/#/conversations/${global.conversationId}` },
      { key: 'supervisor', name: '主管对话', url: `${daemon.url}/#/conversations/${supervisor.conversationId}` },
      { key: 'node', name: '节点对话', url: `${daemon.url}/#/tasks/${global.taskId}/nodes/master` },
    ];
    for (const target of targets) {
      const measurement = await measureWindow(page, target, outDir, label);
      report.windows.push(measurement);
      console.log(`\n${target.name}: ${measurement.problems.length ? `FAIL (${measurement.problems.length})` : 'ok'}`);
      console.log(`  tool groups first paint: ${measurement.groups.map(group => `${group.open} / ${group.height}px / row ${Math.round(group.laidOut)}px`).join(', ')}`);
      console.log(`  turn blocks first paint: ${measurement.turns.map(turn => `${turn.open}`).join(', ') || 'none'}`);
      console.log(`  after one click: ${measurement.opened.open} / ${measurement.opened.height}px; after two: ${measurement.folded.open} / ${measurement.folded.height}px`);
      for (const problem of measurement.problems) console.log(`  - ${problem}`);
      for (const shot of measurement.shots) console.log(`  shot: ${shot}`);
    }

    const failures = report.windows.reduce((total, window) => total + window.problems.length, 0);
    report.ok = failures === 0;
    const reportPath = join(outDir, `${label}-report.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport: ${reportPath}`);
    if (report.ok) {
      const folded = report.windows.reduce((total, window) => total + window.groups.length, 0);
      console.log(`PASS ${report.windows.length} windows: ${folded} tool groups folded, every turn block open`);
    } else {
      console.error(`FAIL ${failures} fold-policy assertion(s) across ${report.windows.length} windows`);
      process.exitCode = 1;
    }
  } catch (reason) {
    console.error(`FAIL ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exitCode = 1;
  } finally {
    if (browser && launchedHere) await browser.close().catch(() => undefined);
    daemon?.stop();
    if (keep) console.log(`kept: ${root}`);
    else await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  // The host-owned browser keeps its socket open; the run is over either way.
  process.exit(process.exitCode ?? 0);
}

await main();
