import { TaskStore } from '../../src/core/store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { mkdir, mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { Proposal } from '../../src/core/types.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-node-prompt-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 90_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-node-prompt-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function launch(): Promise<Page> {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  return browser.newPage();
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting');
}

/**
 * The page shows a subagent's own prompt, and what it shows is the send itself.
 *
 * The provider here is a real HTTP server: the text asserted in the DOM is read back out of
 * the request body the model would have received, so a panel that recomposed a lookalike
 * instead of reading the recorded send fails this test.
 */
test('the node detail shows the system prompt and briefing the subagent really read', async () => {
  const root = await temp('shown');
  const provider = await openaiServer([{ text: 'work done' }, { text: 'extra' }]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key' }),
    },
    actions: {
      check: {
        kind: 'program',
        prepare: async () => async () => ({
          outcome: 'completed', output: { passed: true },
          evidence: [{ acceptanceId: 'works', summary: '检查通过', artifact: { path: join(root, 'ok'), digest: 'a'.repeat(64) } }],
        }),
      },
    },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: '看 subagent 的提示词', requestId: 'begin' });
  await server.runtime.supervisor(begun.taskId).propose({
    requirementVersion: 1, summary: '节点的提示词',
    acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local', input: { files: ['src/a.ts'], focus: '写下结果' } },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  await server.runtime.user.task(begun.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await server.runtime.host.drive();
  await waitFor(() => provider.requests.length >= 1, 30_000);
  const body = provider.requests[0] as { messages?: { role?: string; content?: unknown }[] };
  const sent = body.messages?.find(message => message.role === 'developer' || message.role === 'system')?.content;
  expect(typeof sent).toBe('string');

  const page = await launch();
  await page.goto(`${server.url}/#/tasks/${begun.taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  // A node opens as its own chat tab; its prompt is reached from the top-right toolbar.
  await page.locator('.react-flow__node').filter({ hasText: 'work' }).first().click();
  const section = page.getByTestId('node-prompt');
  await section.waitFor();
  expect(await page.locator('[data-testid="node-chat-tab"] > .conversation-header').count()).toBe(0);
  expect(await section.locator('summary').getAttribute('aria-label')).toBe('System prompt');
  expect(await section.getAttribute('open')).toBeNull();
  await section.locator('summary').click();
  await expect.poll(() => section.getAttribute('open')).not.toBeNull();
  // The tab reads the recorded prompt on open; nothing is recomputed or invented.
  await page.getByTestId('node-prompt-sent-text').waitFor({ timeout: 15_000 });

  expect(await page.getByTestId('node-prompt-role').innerText()).toContain('worker');
  // Byte for byte against the request the provider really received.
  const shown = await page.getByTestId('node-prompt-sent-text').evaluate(element => element.textContent ?? '');
  expect(shown).toBe(sent);
  const tools = await page.getByTestId('node-prompt-sent-tools-text').evaluate(element => element.textContent ?? '');
  expect(tools.length).toBeGreaterThan(0);
  // The other half of what a subagent reads: the briefing of its own session.
  const briefing = await page.getByTestId('node-briefing-text').evaluate(element => element.textContent ?? '');
  expect(briefing).toContain('Your node: work (agent work)');
  expect(briefing).toContain('写下结果');

  // A stable artifact: the temp root is deleted on cleanup, a repeatable screenshot is not.
  const screenshot = '/tmp/graph-node-prompt.png';
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`screenshot: ${screenshot}`);
}, 120_000);

test('native graph chats keep a session and expose the actual provider prompt in an independent tab', async () => {
  const root = await temp('native');
  const capabilityRoot = join(root, 'capabilities');
  await mkdir(capabilityRoot);
  const provider = await openaiServer([{ text: 'native first reply' }, { text: 'native second reply' }]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') }, actions: {},
    limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-test-key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => server.close());
  await server.runtime.catalog.saveAgentCombination({ id: 'native', name: 'Native', description: 'native worker', recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'Native identity.' });
  const parent = await server.runtime.user.begin({ projectId: 'p', request: 'native graph', requestId: 'native-parent' });
  const main = server.runtime.supervisor(parent.taskId);
  const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'native', protocols: { ping: { type: 'object' } },
    templates: { native: { version: 1, definition: { schemaVersion: 2, name: 'inner', protocols: { ping: { type: 'object' } },
      nodes: { worker: { recipe: 'native@1', task: 'reply to chat', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: {} } },
      modules: {}, edges: {}, inputs: {}, outputs: { result: { from: 'worker.out', protocol: 'ping' } } } } },
    instances: { build: { template: 'native', version: 1 } },
    nodes: { observer: { recipe: 'native@1', task: 'wait for a result', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} } },
    modules: {}, edges: { result: { from: 'build.result', to: 'observer.in', enabled: true } } }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'build/worker', text: 'first distinct input' });
  await server.runtime.host.drive();
  const first = server.runtime.nodeRun(graph.graphId, 'build/worker');
  expect(first.session?.sessionId).toBeTruthy();
  await main.graphSend({ graphId: graph.graphId, nodeId: 'build/worker', text: 'second distinct input' });
  await server.runtime.host.drive();
  const second = server.runtime.nodeRun(graph.graphId, 'build/worker');
  expect(second.session?.sessionId).toBe(first.session?.sessionId);
  const configs = await readdir(join(root, 'state', 'kernel-worker'));
  for (const config of configs) expect(await readFile(join(root, 'state', 'kernel-worker', config), 'utf8')).not.toContain('local-test-key');
  expect(second.instance?.used).toBe(100);
  expect(second.entries.some(entry => entry.text.includes('native second reply'))).toBe(true);
  const body = provider.requests.at(-1) as { messages: { role: string; content: string }[] };
  const actual = body.messages.find(message => message.role === 'system' || message.role === 'developer')?.content;
  expect(server.runtime.nodePrompt(graph.graphId, 'build/worker').recorded?.text).toBe(actual);
  const page = await launch();
  await page.goto(`${server.url}/#/tasks/${graph.graphId}/graph`);
  await expect.poll(() => page.locator('.react-flow__edge').count(), { timeout: 10_000 }).toBe(1);
  await page.getByTestId('container-build').click();
  await expect.poll(() => page.locator('[data-node-id="build/worker"]').count()).toBe(0);
  await expect.poll(() => page.locator('.react-flow__edge').count(), { timeout: 10_000 }).toBe(1);
  await page.getByTestId('container-build').click();
  await page.locator('[data-node-id="build/worker"]').click();
  await page.getByTestId('node-prompt').locator('summary').click();
  await expect.poll(() => page.getByTestId('node-prompt-sent-text').textContent()).toBe(actual);
  expect(await page.getByTestId('node-chat-tab').textContent()).toContain('native second reply');
  await main.graphControl({ graphId: graph.graphId, action: 'complete' });
  await server.runtime.host.drive();
  expect((await main.graphInspect({ graphId: graph.graphId })) as object).toBeTruthy();
}, 30000);


// A hanging real provider exposes late SQLite writes and accidental restart after shutdown.
test('closing a native graph aborts its provider and settles durable writers before releasing SQLite', async () => {
  const root = await temp('shutdown');
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const sent = Promise.withResolvers<void>();
  const provider = await openaiServer([{ beforeReply: async () => { sent.resolve(); await new Promise<void>(() => {}); } }]);
  cleanup.push(() => provider.close());
  const stateDir = join(root, 'state');
  const server = await openGraphServer({ stateDir, projects: [{ id: 'p', root }], webDir, actions: {},
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') }, limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-fixture', modelRuntime: provider.runtime },
  });
  cleanup.push(() => server.close());
  await server.runtime.catalog.saveAgentCombination({ id: 'native', name: 'Native', description: 'worker', recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'Work.' });
  const parent = await server.runtime.user.begin({ projectId: 'p', request: 'shutdown', requestId: 'parent' });
  const main = server.runtime.supervisor(parent.taskId);
  const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'shutdown', protocols: {},
    nodes: { worker: { recipe: 'native@1', task: 'reply', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {} }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'worker', text: 'go' });
  const drive = server.runtime.host.drive();
  await sent.promise;
  await server.close();
  await drive;
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite'));
  try {
    const execution = disk.db.prepare('SELECT state,retries_used FROM kernel_executions WHERE task_id=?').get(graph.graphId);
    expect(execution).toEqual({ state: 'blocked', retries_used: 0 });
    expect(disk.db.prepare('SELECT state FROM kernel_queue WHERE task_id=?').get(graph.graphId)).toEqual({ state: 'queued' });
    expect(disk.db.prepare('SELECT state FROM kernel_provider_calls WHERE task_id=?').get(graph.graphId)).toEqual({ state: 'unknown' });
    expect(provider.requests).toHaveLength(1);
  } finally { disk.close(); }
}, 30_000);
