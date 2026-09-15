/**
 * C04 packaged-app acceptance harness.
 *
 * Runs the real packaged Graph.app (dist/app/mac-arm64/Graph.app) with an
 * isolated userData directory, drives the console UI through the Electron
 * renderer over CDP, and proves the chain:
 *   wizard (key via safeStorage + IPC bridge) -> conversation -> draft confirm
 *   -> Git baseline of a non-Git directory -> worker node detail -> talent
 *   -> hot config change with the daemon PID unchanged.
 *
 * No terminal input, no hand-written config document, no environment key: the
 * only credential path is the Electron bridge. The provider is a local fixture.
 *
 * Usage: node docs/planning/acceptance-evidence/unified-console-closeout/c04/app-e2e.mjs
 */
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const evidence = dirname(fileURLToPath(import.meta.url));
const appPath = join(repo, 'dist/app/mac-arm64/Graph.app');
const appBinary = join(appPath, 'Contents/MacOS/Graph');
const steps = [];
const record = (name, ok, detail) => { steps.push({ name, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`); };
const fail = reason => { throw new Error(reason); };
const until = async (fn, timeout, label) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) fail(`timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};

if (!existsSync(appBinary)) fail(`packaged app not found: ${appBinary}`);

// ---------------------------------------------------------------- fixture provider
function fixtureProvider() {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    const messages = body.messages ?? [];
    const isMaster = tools.includes('propose_graph');
    const isNewPrompt = messages.at(-1)?.role === 'user';
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content;
    const prompt = typeof lastUser === 'string' ? lastUser : Array.isArray(lastUser) ? lastUser.map(part => part?.text ?? '').join(' ') : '';
    const requirementVersion = Number(/Requirement version: (\d+)/.exec(prompt)?.[1] ?? 1);
    const usage = { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish) => response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const end = finish => { response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`); response.end('data: [DONE]\n\n'); };
    if (!isMaster) { chunk({ role: 'assistant', content: 'worker finished the packaged-app task' }, null); end('stop'); return; }
    if (!isNewPrompt) { chunk({ role: 'assistant', content: '本轮处理完成。' }, null); end('stop'); return; }
    if (prompt.includes('最小可用版')) {
      const draft = {
        requirementVersion,
        summary: '最小可用版：打通打包 APP 的对话到节点详情',
        acceptance: [{ id: 'ok', description: '检查通过', checkNode: 'check' }],
        nodes: [
          { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
          { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
        ],
      };
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-c04-draft', type: 'function', function: { name: 'propose_graph', arguments: JSON.stringify({ proposalJson: JSON.stringify(draft), requestId: 'c04-draft-1' }) } }] }, null);
      end('tool_calls');
      return;
    }
    chunk({ role: 'assistant', content: '收到。' }, null);
    end('stop');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise(done => server.close(done)) })));
}

async function main() {
  const provider = await fixtureProvider();
  const root = await mkdtemp(join(tmpdir(), 'graph-c04-'));
  const userData = join(root, 'userData');
  const projectRoot = join(root, 'project');
  await mkdir(userData, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'check.js'), 'process.stdout.write("check ok\\n");\n');
  await writeFile(join(projectRoot, 'README.md'), '# packaged app e2e project\n');
  record('fixture provider and workspace', true, { providerPort: provider.port, projectRoot });

  const debugPort = 9411;
  const child = spawn(appBinary, [`--remote-debugging-port=${debugPort}`], {
    env: { ...process.env, GRAPH_APP_USER_DATA: userData, GRAPH_APP_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  const appPid = child.pid;
  record('packaged app launched', true, { appPath, appPid });

  let browser;
  try {
    browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`), 60_000, 'CDP connection');
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = await until(async () => context.pages().find(candidate => !candidate.isClosed()) ?? null, 30_000, 'renderer page');
    page.on('console', message => console.error('CONSOLE', message.type(), message.text().slice(0, 300)));
    page.on('pageerror', error => console.error('PAGEERROR', error.message.slice(0, 300)));
    page.on('requestfailed', request => console.error('REQFAIL', request.url(), request.failure()?.errorText));
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    // Re-navigate once our listeners are attached so asset/script failures are visible.
    await page.reload({ waitUntil: 'load', timeout: 30_000 }).catch(error => console.error('RELOAD', error.message.slice(0, 200)));

    // 1) First-run wizard: key through safeStorage + the IPC bridge.
    try {
      await page.waitForSelector('[data-testid="new-conversation-input"]', { timeout: 60_000, state: 'attached' });
      // First run shows the console with an explicit wizard entry; open it.
      await page.goto(`${new URL(page.url()).origin}/#/setup`);
      try {
        await page.waitForSelector('[data-testid="setup"]', { timeout: 30_000, state: 'attached' });
      } catch (inner) {
        console.error('DEBUG setup missing', JSON.stringify({ url: page.url(), text: (await page.locator('body').innerText().catch(() => '')).slice(0, 300) }));
        throw inner;
      }
    } catch (error) {
      console.error('DEBUG url', page.url());
      console.error('DEBUG body', (await page.locator('body').innerText().catch(() => '')).slice(0, 600));
      console.error('DEBUG html', (await page.content().catch(() => '')).slice(0, 700));
      const probe = await page.evaluate(async () => { const response = await fetch('/api/health'); const asset = await fetch('/assets/index-BRp_egjj.js'); return { health: response.status, asset: asset.status, assetHead: (await asset.text()).slice(0, 60) }; }).catch(error => ({ error: String(error) }));
      console.error('DEBUG probe', JSON.stringify(probe));
      console.error('DEBUG pages', JSON.stringify(context.pages().map(item => item.url())));
      const dom = await page.evaluate(() => ({ ready: document.readyState, root: document.getElementById('root')?.innerHTML?.slice(0, 200) ?? null, scripts: [...document.scripts].map(s => s.src) })).catch(error => ({ error: String(error) }));
      console.error('DEBUG dom', JSON.stringify(dom));
      console.error('DEBUG app stdout', stdout.slice(-1200));
      throw error;
    }
    await page.click('[data-testid="setup-provider-custom"]');
    await page.fill('[data-testid="setup-secret-ref"]', 'GRAPH_E2E_KEY');
    await page.fill('[data-testid="setup-key"]', 'fixture-key-not-a-real-secret');
    await page.click('[data-testid="setup-advanced-toggle"]');
    console.error('DEBUG wizard step advanced');
    await page.waitForSelector('[data-testid="setup-base-url"]', { timeout: 15_000 }).catch(async error => {
      console.error('DEBUG base-url missing', JSON.stringify({ url: page.url(), advanced: await page.locator('[data-testid="setup-advanced-toggle"]').innerText().catch(() => ''), text: (await page.locator('body').innerText().catch(() => '')).slice(0, 400) }));
      throw error;
    });
    console.error('DEBUG wizard step base-url');
    await page.fill('[data-testid="setup-base-url"]', `http://127.0.0.1:${provider.port}/v1`);
    await page.selectOption('[data-testid="setup-api"]', 'openai-completions');
    await page.click('[data-testid="setup-model-add"]');
    console.error('DEBUG wizard model-add 1');
    await page.fill('[data-testid="setup-custom-model-0"] input', 'local');
    await page.selectOption('[data-testid="setup-custom-model-0"] select', 'high');
    await page.click('[data-testid="setup-model-add"]');
    console.error('DEBUG wizard model-add 2');
    await page.fill('[data-testid="setup-custom-model-1"] input', 'local-pro');
    await page.selectOption('[data-testid="setup-custom-model-1"] select', 'highest');
    await page.fill('[data-testid="setup-project-id"]', 'demo');
    await page.fill('[data-testid="setup-project-root"]', projectRoot);
    console.error('DEBUG wizard fields');
    await page.screenshot({ path: join(evidence, '01-setup-wizard.png') });
    await page.click('[data-testid="setup-save"]');
    // The wizard navigates to the console once the key is applied hot.
    const wizardStatus = await until(async () => {
      const statuses = await page.locator('[data-testid="setup-status"], [data-testid="setup-secret-error"], [data-testid="setup-secret-pending"]').allInnerTexts().catch(() => []);
      const text = statuses.join(' | ');
      return text.includes('已保存') || text.includes('密钥未') ? text : null;
    }, 90_000, 'wizard save result');
    // Renderer refresh only: the daemon (and its PID) stays the same; the SPA
    // reloads /api/settings so the newly hot-applied project becomes visible.
    await page.reload({ waitUntil: 'load', timeout: 30_000 });
    await page.goto(`${new URL(page.url()).origin}/#/`);
    await page.waitForSelector('[data-testid="new-conversation-input"]', { timeout: 30_000, state: 'attached' });
    const projectOptions = await page.evaluate(() => [...(document.querySelector('[data-testid="project-select"]')?.options ?? [])].map(option => option.value));
    if (projectOptions.includes('demo')) await page.selectOption('[data-testid="project-select"]', 'demo');
    const secretsPath = join(userData, 'secrets.json');
    const secretsRaw = await readFile(secretsPath, 'utf8');
    const plaintext = secretsRaw.includes('fixture-key-not-a-real-secret');
    record('wizard saved the key through the Electron bridge', !plaintext && existsSync(secretsPath) && wizardStatus.includes('已保存'), { wizardStatus, secretsFile: secretsPath, plaintextInSecretsFile: plaintext, encryptedEntries: Object.keys(JSON.parse(secretsRaw).entries ?? {}) });

    // 2) Conversation -> bind project -> draft -> confirm (non-Git project gets a baseline).
    await page.fill('[data-testid="new-conversation-input"]', '请为这个项目规划最小可用版。');
    await page.click('[data-testid="new-conversation-start"]');
    await page.waitForSelector('[data-testid="conversation"]', { timeout: 30_000 });
    if (await page.locator('[data-testid="bind-select"]').count()) {
      const options = await page.evaluate(() => [...(document.querySelector('[data-testid="bind-select"]')?.options ?? [])].map(option => ({ value: option.value, label: option.textContent })));
      const config = await page.evaluate(async () => (await (await fetch('/api/config')).json()).config.projects);
      console.error('DEBUG bind options', JSON.stringify(options), 'config projects', JSON.stringify(config));
      await page.selectOption('[data-testid="bind-select"]', 'demo').catch(error => { console.error('DEBUG bind fail', error.message.slice(0, 120)); throw error; });
      await page.click('[data-testid="bind-submit"]');
    }
    await page.fill('[data-testid="chat-input"]', '先做最小可用版，注意不要涉及登录。');
    await page.click('[data-testid="chat-send"]');
    await page.waitForSelector('[data-testid="proposal-draft"]', { timeout: 60_000 });
    const draftText = await page.locator('[data-testid="proposal-draft"]').innerText();
    await page.fill('[data-testid="accept-branch"]', 'main');
    await page.click('[data-testid="confirm-draft"]');
    const taskLink = await until(async () => { const links = await page.locator('[data-testid^="conversation-node-link-"]').all(); return links.length ? links : null; }, 60_000, 'confirmed task nodes');
    const href = await taskLink[0].getAttribute('href');
    const taskId = /#\/tasks\/([^/]+)\//.exec(href ?? '')?.[1];
    record('conversation confirmed a draft and created the task', Boolean(taskId), { draftText: draftText.slice(0, 80), taskId, href });

    // 3) Worker node detail with a real Pi/program projection.
    await page.goto(`${new URL(page.url()).origin}/#/tasks/${taskId}/nodes/work`);
    await page.waitForSelector('[data-testid="node-run-work"]', { timeout: 60_000 });
    let entries;
    try {
      entries = await until(async () => { const nodes = await page.locator('[data-testid^="node-entry-"]').allInnerTexts(); return nodes.length ? nodes : null; }, 120_000, 'worker node entries');
    } catch (error) {
      const panel = await page.locator('[data-testid="node-run-work"]').innerText().catch(() => '(no panel)');
      await page.screenshot({ path: join(evidence, '02b-node-stuck.png'), fullPage: true }).catch(() => undefined);
      console.error('DEBUG node stuck', JSON.stringify({ url: page.url(), panel: panel.slice(0, 900) }));
      throw error;
    }
    const operations = await page.locator('[data-testid="node-operations"]').innerText();
    await page.screenshot({ path: join(evidence, '02-node-detail.png'), fullPage: true });
    record('worker node detail shows real entries', entries.length > 0, { entries: entries.length, operations: operations.slice(0, 120) });

    // 4) Git baseline of the previously non-Git directory.
    const gitDir = join(projectRoot, '.git');
    const baseline = existsSync(gitDir) ? execFileSync('git', ['-C', projectRoot, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim() : '';
    record('host initialized Git and committed a baseline', existsSync(gitDir) && baseline.length > 0, { baseline });

    // 5) Talent experience page.
    await page.goto(`${new URL(page.url()).origin}/#/catalog`);
    await page.waitForSelector('[data-testid="definition-coder"]', { timeout: 30_000, state: 'attached' });
    await page.click('[data-testid="definition-coder"]');
    await page.waitForSelector('[data-testid="talent-coder"]', { timeout: 30_000, state: 'attached' });
    const samples = await until(async () => { const list = await page.locator('[data-testid="talent-samples-coder"] li').allInnerTexts(); return list.length ? list : null; }, 60_000, 'talent samples');
    await page.screenshot({ path: join(evidence, '03-talent.png'), fullPage: true });
    record('talent experience lists the packaged-app run', samples.length > 0, { samples: samples.length, first: samples[0]?.slice(0, 80) });

    // 6) Hot config change without a daemon restart.
    const pidOf = () => {
      try {
        const marker = `--state-dir ${join(userData, 'state')}`;
        const match = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').find(line => line.includes(marker));
        return match ? match.trim().split(/\s+/)[0] : '';
      } catch { return ''; }
    };
    const daemonPidBefore = pidOf();
    await page.goto(`${new URL(page.url()).origin}/#/settings`);
    await page.waitForSelector('[data-testid="settings-page"]', { timeout: 30_000 });
    await page.fill('[data-testid="credential-0-group"]', 'e2e-group');
    await page.click('[data-testid="settings-save"]');
    const status = await until(async () => { const text = await page.locator('[data-testid="config-status"]').innerText().catch(() => ''); return text.includes('revision') ? text : null; }, 30_000, 'hot config status');
    const daemonPidAfter = pidOf();
    record('config save applied hot without a restart', daemonPidBefore !== '' && daemonPidBefore === daemonPidAfter, { daemonPidBefore, daemonPidAfter, status });

    await writeFile(join(evidence, 'c04-result.json'), `${JSON.stringify({
      appPath, appPid, userData, projectRoot, providerPort: provider.port, taskId,
      secretsFile: { path: secretsPath, plaintextKey: plaintext },
      daemon: { pidBefore: daemonPidBefore, pidAfter: daemonPidAfter },
      steps,
    }, null, 2)}\n`);
    record('evidence written', true, { file: join(evidence, 'c04-result.json') });
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill('SIGTERM');
    await provider.close();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(`APP_E2E_FAILED ${error.message}`);
  console.error(steps.map(step => `${step.ok ? 'PASS' : 'FAIL'} ${step.name}`).join('\n'));
  process.exit(1);
});
