import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { evidenceDir } from '../helpers/evidence.ts';
import { launchBrowser } from '../helpers/host-browser.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// The footer answers "how fast is this model right now": tokens per second of the
// newest request that wrote tokens, from the provider's own numbers - the output
// count it reported and the milliseconds the call really took. It is on every chat
// footer: the conversation (main Agent and a project supervisor share it), and the
// node chat.
//
// The proof is a real daemon and a real browser. The provider is scripted with a
// deliberate delay, so the rate has a known shape: 240 tokens in about two seconds
// is around 120 tokens/s, and the assertion is a band wide enough for a loaded
// machine but narrow enough to catch a rate that is computed from the wrong pair.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function consoleWithReply(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-console-tps-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  // 240 output tokens after a ~2s pause: the provider decides both numbers, and the
  // pause is what makes the rate a fact instead of a coincidence of a fast machine.
  const provider = await openaiServer([{
    text: '这一轮写满两百多个 token 用来测速。'.repeat(8),
    usage: { prompt_tokens: 900, completion_tokens: 240 },
    beforeReply: () => new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  }, {
    // A provider that answers without usage reports no output at all. It must not
    // blank the rate a real answer already produced.
    text: '这次没有 usage。',
    usage: null,
  }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_TPS_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 512, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, webDir, extraArgs: ['--execute'], env: { GRAPH_TPS_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());
  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', title: 'TPS', text: '请写一段话。', requestId: 'tps-first' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  return { root, daemon, conversationId: (JSON.parse(createdText) as { conversationId: string }).conversationId };
}

test('the conversation footer prints tokens per second from the provider’s own numbers', async () => {
  const { root, daemon, conversationId } = await consoleWithReply('conversation');
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { telemetry?: { outputTokens?: number | null; tokensPerSecond?: number | null } };
    return view.telemetry?.tokensPerSecond ?? null;
  }, { timeout: 40_000, interval: 250 }).not.toBeNull();

  const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as {
    telemetry?: { outputTokens?: number | null; latencyMs?: number | null; tokensPerSecond?: number | null };
  };
  // The two facts the rate is made of, and the rate itself: 240 tokens over ~2s.
  expect(view.telemetry?.outputTokens).toBe(240);
  expect(view.telemetry?.latencyMs).toBeGreaterThan(1_000);
  expect(view.telemetry?.tokensPerSecond).toBeGreaterThan(20);
  expect(view.telemetry?.tokensPerSecond).toBeLessThan(1_000);

  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();
  const tps = page.getByTestId('telemetry-tps');
  await tps.waitFor();
  await expect.poll(async () => await tps.innerText(), { timeout: 15_000 }).toMatch(/TPS \d+/);
  const cacheText = await page.getByTestId('telemetry-cache').innerText();
  expect(cacheText, 'the cache pill no longer abbreviates its label').toMatch(/^CH [\d.]+%/);
  expect(cacheText, 'the cache pill must keep the freshness and drop the token count').toMatch(/^CH [\d.]+% · (刚刚|\d+ (分钟前|小时前|天前))$/);
  const contextText = await page.getByTestId('telemetry-context').innerText();
  expect(contextText, 'the context pill must lead with the percentage').toMatch(/^CONTEXT [\d.]+%/);
  expect(contextText, 'the context pill must shorten the window to K or M').toMatch(/^CONTEXT [\d.]+% \/ [\d.]+[KM]$/);
  for (const id of ['telemetry-cache', 'telemetry-tps', 'telemetry-context', 'telemetry-model']) {
    expect(await page.getByTestId(id).locator('svg').count(), `${id} still carries an icon`).toBe(0);
  }
  // The tooltip says what the number is made of, so nobody has to guess.
  const title = await tps.getAttribute('title');
  expect(title).toContain('240 tokens');
  expect(title).toMatch(/用时 \d+\.\d 秒/);

  // A second turn whose provider answer carries no usage: the footer still shows the
  // newest request that actually wrote tokens, not a dash.
  const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: '再说一句。', requestId: 'tps-second' }),
  });
  expect(second.status, await second.text()).toBe(200);
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages?: { role?: string; text?: string }[] };
    return (view.messages ?? []).map(message => message.text ?? '').join('\n');
  }, { timeout: 40_000, interval: 250 }).toContain('这次没有 usage');
  const afterUsageLess = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as {
    telemetry?: { outputTokens?: number | null; tokensPerSecond?: number | null };
  };
  expect(afterUsageLess.telemetry?.outputTokens, 'a usage-less answer must not erase the last measured rate').toBe(240);
  expect(afterUsageLess.telemetry?.tokensPerSecond).toBeGreaterThan(20);
  await expect.poll(async () => await tps.innerText(), { timeout: 15_000 }).toMatch(/TPS \d+/);
  await page.screenshot({ path: join(evidenceDir(root, 'console-tps'), 'conversation.png'), fullPage: false });
}, 180_000);

test('the node chat footer prints the same rate for the node’s own call', async () => {
  const { root, daemon, conversationId } = await consoleWithReply('node');
  // The master node of the conversation is a real agent node with its own chat; the
  // turn above already gave it one settled request, so this needs no second call.
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { anchorTaskId?: string; telemetry?: { tokensPerSecond?: number | null } };
    if (!view.anchorTaskId || view.telemetry?.tokensPerSecond == null) return null;
    const run = await (await daemon.request(`/api/tasks/${view.anchorTaskId}/nodes/master/run`)).json() as { throughput?: { tokensPerSecond?: number | null } };
    return run.throughput?.tokensPerSecond ?? null;
  }, { timeout: 60_000, interval: 500 }).not.toBeNull();

  const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { anchorTaskId: string };
  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/tasks/${view.anchorTaskId}/nodes/master`);
  const footer = page.getByTestId('node-telemetry-tps');
  await footer.waitFor({ timeout: 30_000 });
  await expect.poll(async () => await footer.innerText(), { timeout: 20_000 }).toMatch(/TPS \d+/);
  const title = await footer.getAttribute('title');
  expect(title).toContain('240 tokens');
  const nodeFooter = await page.locator('.composer-footer').innerText();
  expect(nodeFooter, 'the node composer no longer advertises the keyboard hint').not.toContain('Shift + Enter');
  await page.screenshot({ path: join(evidenceDir(root, 'console-tps'), 'node.png'), fullPage: false });
}, 240_000);

const SKILLS = [
  'skill-codebase-design',
  'skill-tdd',
  'skill-code-review',
];

// A graph node is not a conversation node, so it reads its own ledger. The proof is a
// real graph that actually called the provider: the planner's own call settles, and
// the node chat prints its rate from that call.
test('the node chat footer of a graph node prints the rate of its own provider call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-console-tps-graph-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const graphHome = join(root, 'graph-home');
  for (const skill of SKILLS) {
    const dir = join(graphHome, 'capabilities', 'skills', skill);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${skill}\ndescription: fixture skill for the console rate test\n---\n\n# ${skill}\n`);
  }
  const provider = await openaiServer([{
    text: '计划：先写壳，再写取数，最后补测试。'.repeat(4),
    usage: { prompt_tokens: 900, completion_tokens: 240 },
    beforeReply: () => new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_TPS_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 512, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, webDir, graphHome, extraArgs: ['--execute'], env: { GRAPH_TPS_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const created = await request('/api/conversations', { projectId: 'p', model: 'main', text: '准备开始', requestId: 'tps-graph-conversation' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = String(created.body.conversationId);
  // A graph with one node, created through the same route the console uses. The
  // node is asked to plan the way a person talks to it, so the call under test is
  // the node's own provider request.
  const definition = {
    schemaVersion: 2,
    name: 'TPS 节点',
    protocols: { job: { type: 'object' }, done: { type: 'object' } },
    nodes: {
      planner: { recipe: 'coder@1', model: 'main', task: 'PLAN_THE_WORK', outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
    },
    modules: {}, edges: {},
    outputs: { done: { from: 'planner.out', protocol: 'done' } },
  };
  const made = await request('/api/graphs', { conversationId, definition, targetBranch: 'main', requestId: 'tps-graph' });
  const graphId = String((made.body as Record<string, any>).graphId ?? '');
  expect(graphId, JSON.stringify(made.body)).not.toBe('');
  const said = await request(`/api/tasks/${graphId}/nodes/planner/messages`, { text: '计划这次导出。', requestId: 'tps-plan' });
  expect(said.status, JSON.stringify(said.body)).toBe(200);

  // The planner's real call: the graph node's own ledger, not the conversation's.
  const rate = await expect.poll(async () => {
    const run = (await request(`/api/tasks/${graphId}/nodes/planner/run`)).body as { throughput?: { tokensPerSecond?: number | null } };
    return run.throughput?.tokensPerSecond ?? null;
  }, { timeout: 120_000, interval: 1_000 }).not.toBeNull();

  const run = (await request(`/api/tasks/${graphId}/nodes/planner/run`)).body as {
    throughput: { outputTokens?: number; latencyMs?: number; tokensPerSecond?: number };
  };
  // The rate is the node's own two facts divided: whatever the provider reported as
  // output, over the time that call really took. No figure is taken on trust.
  expect(run.throughput.outputTokens).toBeGreaterThan(0);
  expect(run.throughput.latencyMs).toBeGreaterThan(0);
  expect(run.throughput.tokensPerSecond).toBeCloseTo((run.throughput.outputTokens as number) / ((run.throughput.latencyMs as number) / 1000), 3);

  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/tasks/${graphId}/nodes/planner`);
  const footer = page.getByTestId('node-telemetry-tps');
  await footer.waitFor({ timeout: 30_000 });
  await expect.poll(async () => await footer.innerText(), { timeout: 20_000 }).toMatch(/TPS \d+/);
  expect(await footer.getAttribute('title')).toContain(`${run.throughput.outputTokens} tokens`);
  await page.screenshot({ path: join(evidenceDir(root, 'console-tps'), 'graph-node.png'), fullPage: false });
}, 300_000);
