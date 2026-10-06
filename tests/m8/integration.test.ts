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

/** Real Pi transport: native draft, explicit graph_ready inputs, worker submissions and usage. */
async function controlledProvider(proposal: unknown) {
  const { createServer } = await import('node:http');
  const requests: { master: boolean }[] = [];
  let started = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: { function?: { name?: string } }[];
      messages?: { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[];
    } : {};
    const master = (body.tools ?? []).some(tool =>
      ['propose_graph', 'list_problems', 'resolve_problem'].includes(tool.function?.name ?? ''));
    // The system prompt mentions the tool name, so only a real tool result or
    // tool call counts as an already proposed graph.
    const proposed = (body.messages ?? []).some(message => message.role === 'tool' || message.tool_calls?.some(call => call.function?.name === 'propose_graph'));
    requests.push({ master });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (master && !proposed) {
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-propose', type: 'function', function: { name: 'propose_graph', arguments: JSON.stringify({ proposal, requestId: 'master-proposal' }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    const lastUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    const ready = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content));
    if (master && ready && !started) {
      started = true;
      const calls = ['work1', 'work2'].map((nodeId, index) => ({ index, id: `start-${nodeId}`, type: 'function',
        function: { name: 'graph_send', arguments: JSON.stringify({ graphId: ready[1], nodeId, input: 'job', value: { text: 'Run the assigned work' } }) } }));
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!master && !(body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'))) {
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'finish-work', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: master ? 'proposal submitted' : 'controllable work output' }, finish_reason: null }] })}\n\n`);
    if (!master) await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000));
    // Both main and resident workers provide actual per-request usage.
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
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
    definition: { schemaVersion: 2, name: '集成验收流程', protocols: { result: { type: 'object' } },
      nodes: Object.fromEntries(['work1', 'work2'].map(id => [id, { recipe: 'coder@1', model: 'local', task: 'Run assigned work',
        inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } }])),
      modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } }, outputs: { result: { protocol: 'result' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
      edges: { first: { from: 'work1.done', to: 'check.start', enabled: true }, second: { from: 'work2.done', to: 'check.start', enabled: true } },
      outputs: { result: { from: 'check.result', protocol: 'result' } },
      acceptance: [{ id: 'works', description: '检查脚本通过', kind: 'check', module: 'check' }],
    },
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
    limits: { defaultBudgetTokens: 20_000_000, credentials: { local: 1 } },
  }, null, 2));
  const stateDir = join(workspace, 'state');
  const child = spawn(process.execPath, [
    'src/server/cli.ts',
    '--config', configPath,
    '--state-dir', stateDir,
    '--graph-home', join(workspace, 'graph'),
    '--web-dir', webDir,
    '--port', '0',
    '--execute',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, GRAPH_INTEGRATION_KEY: 'synthetic-integration-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
  const url = await waitForServer(child, 90_000);
  console.log('[integration] server-ready');
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
  page.setDefaultTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(url);
  await page.getByTestId('new-conversation-input').fill('把检查脚本跑通');
  await page.getByTestId('new-conversation-project').selectOption('integration');
  await page.getByTestId('new-conversation-start').click();
  await page.getByTestId('conversation').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="drawer-entry-label"]')?.textContent?.includes('草稿 v1'));
  console.log('[integration] proposal-ready');
  // The draft card lives in the drawer; one click on the labelled entry opens it.
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('proposal-draft').waitFor();
  await page.screenshot({ path: join(evidenceDir, 't08-overview.png') });

  const proposalText = await page.getByTestId('proposal-draft').innerText();
  expect(proposalText).toContain('集成验收流程');
  expect(proposalText).toContain('待确认');
  // The drawer names the draft's window; the graph itself is a tab of its own.
  expect(await page.getByTestId('drawer-entry-graph').innerText()).toContain('任务图');
  await page.screenshot({ path: join(evidenceDir, 't08-confirm.png') });
  await page.getByTestId('confirm-draft').click();
  // After confirming, the task navigation must really open (it used to bounce
  // back to the draft page): wait on the entry state, then the task entries.
  await page.waitForFunction(() => document.querySelector('[data-testid="drawer-entry-label"]')?.textContent?.includes('任务 1'));
  expect(await page.getByTestId('drawer-mode-tabs').count()).toBe(0);
  await page.getByTestId('drawer-task-detail').waitFor();
  expect(await page.getByTestId('drawer-task-detail').innerText()).toContain('任务图');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="conversation-task-"]').length === 1);
  const taskId = await page.evaluate(async () => {
    const conversationId = location.hash.replace('#/conversations/', '');
    const view = await (await fetch(`/api/conversations/${conversationId}`)).json() as { tasks: { id: string }[] };
    return view.tasks[0]!.id;
  });
  // A task is its graph now. The credential cap of one still makes the second work node wait for a
  // slot, but that label lived on the task page: here the card reports its own state, so wait for the
  // node to reach a settled state instead of for a transient label.
  await page.goto(`${url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  console.log('[integration] task-graph-ready');
  await page.locator('.node-card[data-node-id]').first().waitFor();
  await page.getByTestId('legend').waitFor();
  const taskLegend = await page.getByTestId('legend').innerText();
  for (const label of ['待执行', '运行中', '已完成', '被阻塞']) expect(taskLegend).toContain(label);
  await page.goto(`${url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
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

  // The task page is gone, and with it the pause/resume buttons, the task status line and the
  // delivery card it printed. What a task's window shows now is its graph: the run reaching its
  // final state is read from the node cards, and the delivery record stays in the ledger.
  await page.goto(`${url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.node-card[data-status]')];
    return cards.length > 0 && cards.every(card => ['succeeded', 'skipped', 'failed'].includes(card.getAttribute('data-status') ?? ''));
  }, undefined, { timeout: 120_000 });
  console.log('[integration] task-graph-settled');
  const state = await page.evaluate(async id => ({
    task: await (await fetch(`/api/tasks/${id}`)).json(),
    graph: await (await fetch(`/api/tasks/${id}/graph`)).json(),
  }), taskId);
  expect(state.task.nodes.map((node: { id: string }) => node.id).sort()).toEqual(['work1', 'work2']);
  expect(state.task.nodes.every((node: { status: string; used: number }) => node.status === 'succeeded' && node.used === 25)).toBe(true);
  expect(state.graph.interfaces).toEqual(expect.arrayContaining([
    expect.objectContaining({ edgeId: 'first', latest: { text: 'Worker finished' } }),
    expect.objectContaining({ edgeId: 'second', latest: { text: 'Worker finished' } }),
  ]));
  await page.screenshot({ path: join(evidenceDir, 't08-delivery.png') });

  await page.goto(`${url}/#/inbox`);
  await page.getByTestId('inbox-empty').waitFor();
  console.log('[integration] inbox-ready');

  await page.goto(`${url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  expect(pageErrors).toEqual([]);
  const masterRequests = provider.requests.filter(entry => entry.master).length;
  // Proposal, graph_ready and explicit input are handled by the external main.
  expect(masterRequests).toBeGreaterThanOrEqual(2);

  // Stop through the formal signal path and assert the exit outside cleanup.
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'timeout'>(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 10_000))]);
  expect(code).toBe(0);
  expect(child.exitCode).toBe(0);
  expect(() => process.kill(child.pid!, 0)).toThrow();
}, 180_000);
