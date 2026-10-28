import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { build } from 'vite';
import { chromium, type Browser } from 'playwright';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { DEFINITION, masterProvider, run } from './go-graph-confirmation.fixture.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, key: string): string {
  const v = object(value)[key];
  if (typeof v !== 'string' || !v) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return v;
}

test.each(['steer', 'stop', 'stop-restart', 'user-steer', 'user-stop', 'browser-steer', 'browser-stop', 'crash-usage'])('a supervisor or user can %s one running graph node', async mode => {
  const browserControl = mode.startsWith('browser-');
  const userControl = mode.startsWith('user-') || browserControl;
  const stopping = mode.includes('stop');
  const root = await mkdtemp(join(tmpdir(), 'graph-node-steer-'));
  let graph = '';
  let started = false;
  let startedOther = false;
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const directive = 'Use the verified source before answering.';
  const control = () => ({ action: stopping ? 'stop_node' : 'steer', taskId: graph, nodeId: 'a', text: directive, requestId: 'control-node' });
  const master = await masterProvider(() => mode === 'crash-usage' ? [] : [{ id: 'steer-node', name: 'control_task', args: control, before: async () => { await expect.poll(() => started && (!stopping || startedOther), { timeout: 20_000 }).toBe(true); } }, { id: 'steer-repeat', name: 'control_task', args: control }]);
  const requests: string[] = [];
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push(body);
    if (body.includes('Independent task')) { startedOther = true; await hold; }
    else if (!started) { started = true; await hold; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: body.includes(directive) ? 'Following the verified source.' : 'Working.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address();
  if (!address || typeof address === 'string') throw new Error('Provider unavailable');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let browser: Browser | undefined;
  try {
    const project = join(root, 'project');
    await mkdir(project);
    if (browserControl) await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(root, 'web'), emptyOutDir: true } });
    else { await mkdir(join(root, 'web')); await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>'); }
    await writeFile(join(project, 'README.md'), '# project\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) await run('git', args, { cwd: project });
    const config = join(root, 'graph.config.json');
    const common = { api: 'openai-completions', maxTokens: 256, credentialId: 'local', contextWindow: 32000 };
    await writeFile(config, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_STEER_KEY' } }, models: { entries: [
      { ...common, id: 'main', provider: 'graph-master', grade: 'high', baseUrl: master.baseUrl }, { ...common, id: 'sender', provider: 'graph-node', grade: 'medium', baseUrl: `http://127.0.0.1:${address.port}/v1` },
    ] } }));
    const start = () => launchCli(root, { configPath: config, extraArgs: ['--execute'], env: { GRAPH_STEER_KEY: 'synthetic-key' } });
    daemon = await start();
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return object(value);
    }
    const conversation = text(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    graph = text(await request('/api/graphs', { conversationId: conversation, definition: DEFINITION, targetBranch: 'main', requestId: 'graph' }), 'graphId');
    await request(`/api/tasks/${graph}/nodes/a/messages`, { text: 'Investigate the source.', requestId: 'node-input' });
    if (stopping) await request(`/api/tasks/${graph}/nodes/b/messages`, { text: 'Independent task.', requestId: 'other-input' });
    await expect.poll(() => started && (!stopping || startedOther), { timeout: 20_000 }).toBe(true);
    if (mode === 'crash-usage') {
      const exited = once(daemon.child, 'exit');
      daemon.child.kill('SIGKILL');
      await exited;
      release();
      daemon = await start();
      const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const pending = db.prepare("SELECT id,state,execution_id FROM kernel_provider_calls WHERE task_id=? AND node_id='a' AND state='unknown'").get(graph);
      const interrupted = db.prepare("SELECT seq,state FROM kernel_queue WHERE task_id=? AND node_id='a'").get(graph);
      db.close();
      expect(pending).toBeDefined();
      const interruptedSeq = object(interrupted).seq;
      if (typeof interruptedSeq !== 'number') throw new Error('Missing interrupted queue sequence');
      const denied = await daemon.request(`/api/tasks/${graph}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'resume', nodeId: 'a' }) });
      expect(denied.status).not.toBe(200);
      const deniedRetry = await daemon.request(`/api/tasks/${graph}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'retry', seq: interruptedSeq }) });
      expect(deniedRetry.status).not.toBe(200);
      const reconciliation = { action: 'reconcile_usage', callId: text(pending, 'id'), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
      const fractional = await daemon.request(`/api/tasks/${graph}/graph/control`, { method: 'POST', body: JSON.stringify({ ...reconciliation, usage: { ...reconciliation.usage, input: 10.5 } }) });
      expect(fractional.status).not.toBe(200);
      expect(await request(`/api/tasks/${graph}/graph/control`, reconciliation)).toMatchObject({ replayed: false, nodeId: 'a' });
      expect(await request(`/api/tasks/${graph}/graph/control`, reconciliation)).toMatchObject({ replayed: true, nodeId: 'a' });
      const state = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const paused = state.prepare("SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id='a'").get(graph);
      const queued = state.prepare("SELECT seq,state FROM kernel_queue WHERE task_id=? AND node_id='a'").get(graph);
      state.close();
      expect(paused).toMatchObject({ paused: 1 });
      expect(queued).toMatchObject({ state: 'failed' });
      const seq = object(queued).seq;
      if (typeof seq !== 'number') throw new Error('Missing queue sequence');
      await request(`/api/tasks/${graph}/graph/control`, { action: 'retry', seq });
      await expect.poll(() => requests.length, { timeout: 20_000 }).toBeGreaterThan(1).catch(async () => { throw new Error(`node=${JSON.stringify(await request(`/api/tasks/${graph}/nodes/a/run`))}; task=${JSON.stringify(await request(`/api/tasks/${graph}`))}; stderr=${daemon?.stderr}`); });
      await expect.poll(async () => JSON.stringify((await request(`/api/tasks/${graph}/nodes/a/run`)).operations), { timeout: 20_000 }).toContain('"state":"completed"');
      const after = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const executions = after.prepare("SELECT id,state FROM kernel_executions WHERE task_id=? AND node_id='a'").all(graph);
      after.close();
      expect(executions).toEqual([expect.objectContaining({ id: text(pending, 'execution_id'), state: 'blocked' }), expect.objectContaining({ state: 'completed' })]);
      return;
    }
    if (!userControl) await request(`/api/conversations/${conversation}/messages`, { text: 'Guide the running node to use the verified source.', requestId: 'steer-request' });
    const releaseTimer = setTimeout(release, browserControl ? 15_000 : 2_000);
    if (userControl) {
      if (browserControl) {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(`${daemon.url}/#/tasks/${graph}/nodes/a`);
        await expect.poll(() => page.getByTestId('node-chat-input').isVisible(), { timeout: 20_000 }).toBe(true);
        if (!stopping) await page.getByTestId('node-chat-input').fill(directive);
        await page.getByRole('button', { name: stopping ? '停止节点' : '立即引导' }).click();
        if (!stopping) await expect.poll(() => page.getByTestId('node-message-list').innerText(), { timeout: 20_000 }).toContain(directive);
      } else {
        const command = { action: stopping ? 'stop_node' : 'steer_node', nodeId: 'a', text: directive, requestId: 'user-control' };
        const first = await request(`/api/tasks/${graph}/graph/control`, command);
        expect(await request(`/api/tasks/${graph}/graph/control`, command)).toEqual(first);
      }
    } else {
      await expect.poll(() => master.results.has('steer-node'), { timeout: 20_000 }).toBe(true).catch(async () => { throw new Error(`master=${JSON.stringify(await request(`/api/conversations/${conversation}`))}; results=${JSON.stringify([...master.results])}; failures=${JSON.stringify(master.failures)}; turns=${master.turns()}; worker=${requests.length}; stderr=${daemon?.stderr}`); });
      if (!stopping) expect(master.results.get('steer-node')).toContain('"steered":true');
      else expect(master.results.get('steer-node')).toContain('"nodeId":"a"');
      await expect.poll(() => master.results.has('steer-repeat'), { timeout: 20_000 }).toBe(true);
      expect(master.results.get('steer-repeat')).toEqual(master.results.get('steer-node'));
    }
    clearTimeout(releaseTimer);
    release();
    if (!stopping) {
      await expect.poll(() => requests.some(body => body.includes(directive)), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => JSON.stringify(await request(`/api/tasks/${graph}/nodes/a/run`)), { timeout: 20_000 }).toContain('Following the verified source.');
    } else {
      await expect.poll(async () => JSON.stringify((await request(`/api/tasks/${graph}/nodes/a/run`)).operations), { timeout: 20_000 }).toContain('"state":"blocked"');
      await expect.poll(async () => JSON.stringify((await request(`/api/tasks/${graph}/nodes/b/run`)).operations), { timeout: 20_000 }).toContain('"state":"completed"');
      const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const pending = db.prepare("SELECT state FROM kernel_provider_calls WHERE task_id=? AND node_id='a' AND state='unknown'").all(graph);
      const paused = db.prepare("SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id='a'").get(graph);
      db.close();
      expect(paused).toMatchObject({ paused: 1 });
      if (mode === 'stop-restart') {
        const previousRequests = requests.length;
        const exited = once(daemon.child, 'exit');
        daemon.child.kill('SIGKILL');
        await exited;
        daemon = await start();
        await new Promise(resolve => setTimeout(resolve, 800));
        expect(requests.length).toBe(previousRequests);
        const restored = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
        const state = restored.prepare("SELECT paused FROM kernel_node_state WHERE task_id=? AND node_id='a'").get(graph);
        restored.close();
        expect(state).toMatchObject({ paused: 1 });
      }
      if (pending.length) {
        const resumed = await daemon!.request(`/api/tasks/${graph}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'resume', nodeId: 'a' }) });
        expect(resumed.status).not.toBe(200);
      }
    }
    const view = await request(`/api/tasks/${graph}/nodes/a/run`);
    expect(view.operations).toEqual([expect.objectContaining({ state: stopping ? 'blocked' : 'completed' })]);
    const eventsResponse = await daemon!.request(`/api/tasks/${graph}/events?after=0&limit=500`);
    const events: unknown = await eventsResponse.json();
    const controlEvents = Array.isArray(events) ? events.filter(item => object(item).type === (stopping ? 'graph.node.stop_requested' : 'operation.steered') && object(object(item).data).actor === (userControl ? 'user' : 'agent')) : [];
    expect(controlEvents).toHaveLength(1);
    expect(object(object(controlEvents[0]).data).actor).toBe(userControl ? 'user' : 'agent');
  } finally {
    release(); await browser?.close(); await daemon?.close(); await master.close(); worker.closeAllConnections();
    await new Promise<void>(resolve => worker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
