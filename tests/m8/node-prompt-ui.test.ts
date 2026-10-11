import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { TaskStore } from '../../src/core/store.ts';
import { appendNodeEntry } from '../../src/core/node-run.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { mkdir, mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import type { NativeProposal } from '../../src/core/types.ts';

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

test('native draft preview renders modules, named interfaces and the actual graph count', async () => {
  const root = await temp('native-draft');
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    actions: { master: { kind: 'agent', reserveTokens: 1, prepare: async () => async () => ({ outcome: 'completed', output: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) } },
    master: { action: 'master', definitionVersion: 'master@1', model: 'scripted' },
  });
  cleanup.push(() => server.close());
  const conversation = await server.runtime.conversations.create({ projectId: 'p', text: 'Preview the native graph', requestId: 'create' });
  const anchor = (await server.runtime.conversations.view(conversation.conversationId)).anchorTaskId;
  await server.runtime.supervisor(anchor).propose({ requirementVersion: 1, summary: 'Native draft preview',
    acceptance: [{ id: 'reviewed', description: 'Review the result', checkNode: 'gate' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'native-draft', protocols: { result: { type: 'object' } },
      nodes: { worker: { recipe: 'worker@1', task: 'Write the result', inputs: { job: { protocol: 'result' } }, outputs: { result: { protocol: 'result' } }, submission: {} } },
      modules: { gate: { type: 'router', trigger: 'once', inputs: { review: { protocol: 'result' } }, outputs: { accepted: { protocol: 'result' } }, rules: [] } },
      edges: { review: { from: 'worker.result', to: 'gate.review', enabled: true } },
      acceptance: [{ id: 'reviewed', description: 'Review the result', kind: 'human' }] }),
  }, 'draft');
  const page = await launch();
  await page.goto(`${server.url}/#/conversations/${conversation.conversationId}/graph?v=1`);
  await expect.poll(() => page.locator('[data-node-id]').count()).toBe(2);
  await expect.poll(() => page.locator('.conversation-graph-meta').textContent()).toContain('2 个节点');
  await page.locator('[data-node-id="gate"]').click();
  await expect.poll(() => page.getByTestId('conversation-node-detail').textContent()).toContain('功能模块');
  expect(await page.getByTestId('conversation-node-detail').textContent()).toContain('review');
  expect(await page.getByTestId('conversation-node-detail').textContent()).toContain('accepted');
  await page.locator('.react-flow__edge').click();
  await expect.poll(() => page.getByTestId('graph-edge-inspector').textContent()).toContain('worker.result');
  expect(await page.getByTestId('graph-edge-inspector').textContent()).toContain('gate.review');
  expect(await page.getByTestId('graph-edge-inspector').textContent()).toContain('尚无投递');
  const confirmed = await server.runtime.conversations.confirm(conversation.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
  // The already-open draft window must become the actual runtime view, including patches.
  await page.getByTestId('graph').waitFor();
  await server.runtime.supervisor(confirmed.taskId).graphPatch({ graphId: confirmed.taskId, baseRevision: 1,
    changes: { reason: 'rename interface connection', patch: { edges: { review: { enabled: false } } } } });
  await expect.poll(() => page.getByTestId('revisions').textContent()).toContain('v2');
  const runtimeGraph = await (await page.request.get(`${server.url}/api/tasks/${confirmed.taskId}/graph`)).json();
  expect(runtimeGraph.interfaces[0].enabled).toBe(false);
  await page.goto(`${server.url}/#/tasks/${confirmed.taskId}/graph`);
  await page.locator('[data-testid="graph"]:visible').waitFor();
  expect(await page.locator('[data-testid="revisions"]:visible').textContent()).toContain('v2');
}, 30_000);

test('a node automatically fills short collapsed history with older messages and tools', async () => {
  const root = await temp('history');
  const stateDir = join(root, 'state');
  const server = await openGraphServer({ stateDir, projects: [{ id: 'p', root }], webDir, autoDrive: false });
  cleanup.push(() => server.close());
  const owner = await server.runtime.user.begin({ projectId: 'p', request: 'history', requestId: 'begin' });
  const graph = await server.runtime.supervisor(owner.taskId).graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'history', protocols: {},
    nodes: { work: { recipe: 'worker@1', task: 'history', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {} }) }) as { graphId: string };
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite'));
  try {
    appendNodeEntry(disk, { taskId: graph.graphId, nodeId: 'work', role: 'user', kind: 'chat', text: 'Earliest node message', operationId: 'history' });
    for (let n = 0; n < 130; n++) {
      const data = { toolName: 'read', toolCallId: `history-${n}` };
      appendNodeEntry(disk, { taskId: graph.graphId, nodeId: 'work', operationId: 'history', role: 'tool', kind: 'call', text: JSON.stringify({ name: 'read', args: { path: `file-${n}` } }), data });
      appendNodeEntry(disk, { taskId: graph.graphId, nodeId: 'work', operationId: 'history', role: 'tool', kind: 'result', text: `RESULT_${n}`, data });
    }
    appendNodeEntry(disk, { taskId: graph.graphId, nodeId: 'work', role: 'assistant', kind: 'message', text: 'Latest history reply', operationId: 'history' });
  } finally { disk.close(); }
  const page = await launch();
  await page.goto(`${server.url}/#/tasks/${graph.graphId}/nodes/work`);
  await page.getByText('Latest history reply', { exact: true }).waitFor();
  await expect.poll(() => page.getByTestId('node-message-list').textContent()).toContain('Earliest node message');
  expect(await page.getByTestId('node-load-older').count()).toBe(0);
  await page.getByRole('button', { name: '展开这一轮的思考与工具调用', exact: true }).click();
  await page.getByRole('button', { name: '展开工具活动', exact: true }).click();
  await page.getByText('RESULT_0', { exact: true }).waitFor({ state: 'visible' });
}, 30_000);

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
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const begun = await server.runtime.user.begin({ projectId: 'p', request: '看 subagent 的提示词', requestId: 'begin' });
  const main = server.runtime.supervisor(begun.taskId);
  const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: '节点的提示词', protocols: { job: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: '写下结果', acceptance: ['Respond to the assigned focus'],
      inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } }, modules: {}, edges: {} }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'job', value: { files: ['src/a.ts'], focus: '写下结果' } });
  await server.runtime.host.drive();
  await waitFor(() => provider.requests.length >= 1, 30_000);
  const body = provider.requests[0] as { messages?: { role?: string; content?: unknown }[] };
  const sent = body.messages?.find(message => message.role === 'developer' || message.role === 'system')?.content;
  expect(typeof sent).toBe('string');

  const page = await launch();
  await page.goto(`${server.url}/#/tasks/${graph.graphId}/graph`);
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
  expect(briefing).toContain('TASK: 写下结果');
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
  const other = await openaiServer([{ text: 'wrong connection' }, { text: 'wrong connection' }]);
  cleanup.push(() => other.close());
  cleanup.push(() => provider.close());
  const library = openAgentContextLibrary(join(root, 'prompts')); await library.ensure();
  await library.savePrompt('runtime/node.md', 'NODE RUNTIME FIRST: use the declared graph outputs.');
  const server = await openGraphServer({ agentContext: library, stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') }, actions: {},
    limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [
      { id: 'other', modelId: 'same-upstream', provider: other.model.provider, grade: 'low', api: 'openai-completions', baseUrl: other.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
      { id: 'local', modelId: 'same-upstream', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
    ], apiKey: 'local-test-key', modelRuntime: provider.runtime },
  });
  cleanup.push(() => server.close());
  await server.runtime.catalog.saveAgentCombination({ id: 'native', name: 'Native', description: 'native reviewer', recommendedGrade: 'medium', review: true, tags: [], resources: [], systemPrompt: 'Native identity.' });
  const parent = await server.runtime.user.begin({ projectId: 'p', request: 'native graph', requestId: 'native-parent' });
  const main = server.runtime.supervisor(parent.taskId);
  const graph = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'native', defaults: { budget: { tokens: 2000000 } }, protocols: { ping: { type: 'object' } },
    templates: { native: { version: 1, definition: { schemaVersion: 2, name: 'inner', defaults: { budget: { tokens: 1000000 } }, protocols: { ping: { type: 'object' } },
      nodes: { worker: { recipe: 'native@1', task: 'reply to chat', inputs: {}, outputs: { out: { protocol: 'ping' } }, submission: {} } },
      modules: {}, edges: {}, inputs: {}, outputs: { result: { from: 'worker.out', protocol: 'ping' } } } } },
    instances: { build: { template: 'native', version: 1 } },
    nodes: { observer: { recipe: 'native@1', task: 'wait for a result', inputs: { in: { protocol: 'ping' } }, outputs: {}, submission: {} } },
    modules: {}, edges: { result: { from: 'build.result', to: 'observer.in', enabled: true } } }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'build/worker', text: 'first distinct input' });
  await server.runtime.host.drive();
  expect(other.requests).toHaveLength(0);
  expect(provider.requests).toHaveLength(1);
  const first = server.runtime.nodeRun(graph.graphId, 'build/worker');
  expect(first.session?.sessionId).toBeTruthy();
  expect(first.instance?.budget).toBe(1000000);
  expect(server.runtime.nodePrompt(graph.graphId, 'build/worker').recorded?.text).toContain('NODE RUNTIME FIRST');
  await library.savePrompt('runtime/node.md', 'NODE RUNTIME NEXT: inspect the new task instructions.');
  await main.graphPatch({ graphId: graph.graphId, baseRevision: 1, changes: { reason: 'next execution quota', patch: { nodes: { 'build/worker': { budget: { tokens: 1500000 } } } } } });
  await main.graphSend({ graphId: graph.graphId, nodeId: 'build/worker', text: 'second distinct input' });
  await server.runtime.host.drive();
  const second = server.runtime.nodeRun(graph.graphId, 'build/worker');
  expect(second.session?.sessionId).toBe(first.session?.sessionId);
  expect(second.node.role).toBe('reviewer');
  expect(server.runtime.nodePrompt(graph.graphId, 'build/worker').role).toBe('reviewer');
  expect(server.runtime.nodePrompt(graph.graphId, 'build/worker').recorded?.text).toContain('NODE RUNTIME NEXT');
  const configs = await readdir(join(root, 'state', 'kernel-worker'));
  for (const config of configs) expect(await readFile(join(root, 'state', 'kernel-worker', config), 'utf8')).not.toContain('local-test-key');
  expect(second.instance?.used).toBe(100);
  expect(second.instance?.budget).toBe(1500000);
  expect((second.operations as { tokenBudget: { budget: number } }[]).map(item => item.tokenBudget.budget)).toEqual([1000000, 1500000]);
  const calls = await main.graphInspect({ graphId: graph.graphId, query: 'provider_calls' }) as { id: string; model: { id: string; identity: string; baseUrl: string }; state: string; usage: { input: number; output: number } }[];
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map(call => call.id)).size).toBe(2);
  for (const call of calls) {
    expect(call.model).toMatchObject({ id: 'local', identity: 'same-upstream', baseUrl: provider.model.baseUrl });
    expect(call.state).toBe('settled');
    expect(call.usage).toMatchObject({ input: 25, output: 10, cacheRead: 15 });
  }
  expect(second.invocations).toHaveLength(2);
  expect(second.instance?.modelsUsed).toEqual(['local']);
  expect(second.entries.some(entry => entry.text.includes('native second reply'))).toBe(true);
  const body = provider.requests.at(-1) as { messages: { role: string; content: string }[] };
  const actual = body.messages.find(message => message.role === 'system' || message.role === 'developer')?.content;
  expect(server.runtime.nodePrompt(graph.graphId, 'build/worker').recorded?.text).toBe(actual);
  await server.runtime.user.task(graph.graphId).setBudget({ nodeId: 'build/worker', tokens: 2000000, requestId: 'native-ui-user-quota' });
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
  await expect.poll(() => page.getByTestId('node-overview').textContent()).toContain('预算 1,500,000');
  await expect.poll(() => page.getByTestId('node-overview').textContent()).toContain('用户授权2,000,000');
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
