import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { git } from '../../src/git/git.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-integration-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

function waitForServer(child: ReturnType<typeof spawn>, deadlineMs = 30_000) {
  return new Promise<string>((resolveUrl, reject) => {
    let buffer = '';
    const deadline = setTimeout(() => reject(new Error(`daemon did not print an address\n${buffer}`)), deadlineMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /address:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
      if (match) { clearTimeout(deadline); resolveUrl(match[1]!); }
    });
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`daemon exited early with ${code}\n${buffer}`)); });
  });
}

/** One controlled provider for the whole flow: the master gets a
 * propose_graph tool call, every other request is a delayed answer without
 * authoritative usage. */
async function controlledProvider(proposal: unknown) {
  const { createServer } = await import('node:http');
  const requests: { master: boolean }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function?: { name?: string } }[]; messages?: { role?: string; tool_calls?: { function?: { name?: string } }[] }[] } : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    // The system prompt mentions the tool name, so only a real tool result or
    // tool call counts as an already proposed graph.
    const proposed = (body.messages ?? []).some(message => message.role === 'tool' || message.tool_calls?.some(call => call.function?.name === 'propose_graph'));
    requests.push({ master: master && !proposed });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (master && !proposed) {
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-propose', type: 'function', function: { name: 'propose_graph', arguments: JSON.stringify({ proposalJson: JSON.stringify(proposal), requestId: 'master-proposal' }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: master ? 'proposal submitted' : 'controllable work output' }, finish_reason: null }] })}\n\n`);
    if (!master) await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000));
    // Only worker answers lack authoritative usage; the master continuation is billed normally.
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: master ? { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } : null })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); });
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests };
}

test('the full productized flow runs from the formal start entry with a controlled provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'graph-m8-integration-'));
  cleanup.push(() => rm(workspace, { recursive: true, force: true }));
  const project = join(workspace, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Integration project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);

  const proposal = {
    requirementVersion: 1,
    summary: '集成验收流程',
    acceptance: [{ id: 'works', description: '检查脚本通过', checkNode: 'check' }],
    nodes: [
      { id: 'work1', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'work2', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work1', 'work2'], input: { command: 'node', args: ['test/check.js'] } },
    ],
  };
  const provider = await controlledProvider(proposal);
  const configPath = join(workspace, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'integration', root: project }],
    models: {
      entries: [{
        id: 'local', provider: 'controlled', grade: 'high', api: 'openai-completions', baseUrl: provider.baseUrl,
        contextWindow: 32_000, maxTokens: 512, credentialId: 'local',
      }],
    },
    credentials: { local: { secretRef: 'GRAPH_INTEGRATION_KEY' } },
    limits: { credentials: { local: 1 } },
  }, null, 2));
  const stateDir = join(workspace, 'state');
  const child = spawn(process.execPath, ['src/server/cli.ts', '--config', configPath, '--state-dir', stateDir, '--web-dir', webDir, '--port', '0', '--execute'], {
    cwd: process.cwd(),
    env: { ...process.env, GRAPH_INTEGRATION_KEY: 'synthetic-integration-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
  const url = await waitForServer(child);
  // The bounded cleanup only guarantees no orphan; the real exit assertion
  // lives in the test body below so it cannot be swallowed.
  const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)));
  cleanup.push(() => { child.kill('SIGTERM'); });

  // Screenshots are run artifacts, not repository state; keeping them in the
  // temporary workspace means a full test run never dirties git.
  const evidenceDir = join(workspace, 'screenshots');
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(url);
  await page.getByTestId('new-conversation-input').fill('把检查脚本跑通');
  await page.getByTestId('new-conversation-project').selectOption('integration');
  await page.getByTestId('new-conversation-start').click();
  await page.getByTestId('conversation').waitFor();
  await page.getByTestId('proposal-draft').waitFor();
  await page.screenshot({ path: join(evidenceDir, 't08-overview.png') });

  const proposalText = await page.getByTestId('proposal-draft').innerText();
  expect(proposalText).toContain('验收项');
  expect(proposalText).toContain('任务图');
  await page.screenshot({ path: join(evidenceDir, 't08-confirm.png') });
  await page.getByTestId('confirm-draft').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="conversation-task-"]').length === 1);
  const taskId = await page.evaluate(async () => {
    const conversationId = location.hash.replace('#/conversations/', '');
    const view = await (await fetch(`/api/conversations/${conversationId}`)).json() as { tasks: { id: string }[] };
    return view.tasks[0]!.id;
  });
  await page.goto(`${url}/#/tasks/${taskId}`);
  await page.getByTestId('proposal').waitFor();

  // The credential cap is one, so the second work node must wait for a slot.
  await page.waitForFunction(() => document.querySelector('[data-testid="node-list"]')?.textContent?.includes('等待 API 名额'));
  expect(await page.getByTestId('node-list').innerText()).toContain('等待 API 名额');
  await page.screenshot({ path: join(evidenceDir, 't08-waiting.png') });
  // A config change during the wait is versioned, takes effect on restart, and must not disturb the running task.
  const saved = await page.evaluate(async currentPath => {
    const response = await fetch('/api/config', { headers: { 'content-type': 'application/json' } });
    const current = await response.json() as { revision: number; config: Record<string, unknown> };
    const document = { version: 1, projects: current.config.projects, models: current.config.models, credentials: current.config.credentials, limits: current.config.limits };
    const savedResponse = await fetch('/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: current.revision, document }),
    });
    return { status: savedResponse.status, body: await savedResponse.json(), path: currentPath };
  }, configPath);
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ restartRequired: false, applied: true, effectiveRevision: 1 });

  // Both work results have no authoritative usage, so each opens an explicit question.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="questions"] li').length === 2, undefined, { timeout: 60_000 });

  // Pause and resume through the UI while the graph is blocked on questions,
  // so the restart of dispatch is observed without racing the check node.
  await page.getByTestId('pause').click();
  await page.waitForFunction(() => { const text = document.querySelector('[data-testid="status"]')?.textContent ?? ''; return text.includes('暂停'); });
  await page.getByTestId('resume').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="status"]')?.textContent ?? '').includes('暂停'));

  // Answer one question at a time: the list shrinks after each answer, so a
  // fixed nth() locator would race the refresh.
  for (let answered = 0; answered < 2; answered += 1) {
    const row = page.getByTestId('questions').locator('li').first();
    await row.getByTestId('usage-mode').selectOption('reconcile');
    await row.getByTestId('usage-proof').fill('受控供应商未返回 usage，保留未知');
    await row.getByRole('button', { name: '答复' }).click();
    await page.waitForFunction(expected => document.querySelectorAll('[data-testid="questions"] li').length === expected, 1 - answered, { timeout: 30_000 });
  }
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="questions"] li').length === 0);

  await page.waitForFunction(() => document.querySelector('[data-testid="delivery"]')?.textContent?.includes('Command exited 0'), undefined, { timeout: 60_000 });
  const delivery = await page.getByTestId('delivery').innerText();
  expect(delivery).toContain('目标分支 main');
  expect(delivery).toContain('Command exited 0: node');
  expect(delivery).not.toContain('尚无有效证据');
  await page.screenshot({ path: join(evidenceDir, 't08-delivery.png') });

  await page.goto(`${url}/#/inbox`);
  await page.getByTestId('inbox-history').waitFor();
  const history = await page.getByTestId('inbox-history').innerText();
  expect(history).toContain('用量未知待核对');
  expect(history).toContain('处理结果');

  await page.goto(`${url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  expect(pageErrors).toEqual([]);
  const masterRequests = provider.requests.filter(entry => entry.master).length;
  expect(masterRequests).toBe(1);

  // Stop through the formal signal path and assert the exit outside cleanup.
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'timeout'>(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 10_000))]);
  expect(code).toBe(0);
  expect(child.exitCode).toBe(0);
  expect(() => process.kill(child.pid!, 0)).toThrow();
}, 180_000);
