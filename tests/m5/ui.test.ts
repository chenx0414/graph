import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openaiServer } from '../fixtures/openai-server.ts';
import { openGraphServer } from '../../src/server/host.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// Each browser suite builds into its own directory; a shared dist/web would
// let one suite empty it while another is loading the hashed assets.
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m5-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));

test('the local UI shows native feedback, self and parallel edges with the actual grid routes and remains read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'project', root }], autoDrive: false, webDir });
  cleanup.push(() => server.close()); server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'pub');
  const { taskId: ownerId } = await server.runtime.user.begin({ projectId: 'project', request: 'Show graph', requestId: 'begin' });
  const data = { protocol: 'data' };
  const { graphId: taskId } = await server.runtime.supervisor(ownerId).graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Native feedback and parallel routes', protocols: { data: { type: 'object' } },
    nodes: { implement: { recipe: 'coder@1', task: 'Implement the task', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
    edges: { forward: { from: 'implement.result', to: 'check.job', enabled: true }, parallel: { from: 'implement.result', to: 'check.job', enabled: true }, feedback: { from: 'check.result', to: 'implement.job', enabled: true }, self: { from: 'implement.result', to: 'implement.job', enabled: true } },
  }) }) as { graphId: string };
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByTestId('new-conversation-input').waitFor();
  await page.getByTestId('conversation-list').waitFor();
  await page.goto(`${server.url}/#/catalog`);
  await page.getByTestId('catalog').waitFor();
  await page.getByTestId('resource-nav-agents').click();
  await page.getByTestId('resource-section-agents').waitFor();
  expect(await page.getByTestId('resource-section-agents').innerText()).toContain('暂无 Agent 配方');
  expect(await page.getByTestId('resource-section-agents').innerText()).not.toContain('coder@1');
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  expect(await page.getByTestId('graph').getAttribute('data-editable')).toBe('false');
  await page.getByTestId('flow').waitFor();
  const edgePath = page.locator('.react-flow__edge-path').first();
  await edgePath.waitFor({ state: 'attached' });
  expect(await page.locator('.react-flow__edge.grid-edge').count()).toBeGreaterThan(0);
  expect(await edgePath.getAttribute('d')).not.toMatch(/[CQ]/);
  expect(await page.locator('.react-flow__background circle').count()).toBeGreaterThan(0);
  const geometry = await page.evaluate(async id => (await fetch(`/api/tasks/${id}/graph`)).json(), taskId) as { layout: { edges: { id: string; points: { x: number; y: number }[] }[] } };
  await expect.poll(() => page.locator('.react-flow__edge.grid-edge').count()).toBe(4);
  for (const edge of geometry.layout.edges) {
    const path = page.locator(`[data-testid="rf__edge-${edge.id}"] .react-flow__edge-path`);
    await path.waitFor({ state: 'attached' });
    expect((await path.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number), edge.id).toEqual(edge.points.flatMap(point => [point.x, point.y]));
  }
  const implement = page.locator('.react-flow__node').filter({ hasText: 'implement' }).first();
  await implement.waitFor({ state: 'visible' });
  expect(await page.locator('.node-card[data-node-id="implement"]').innerText()).toContain('implement agent');
  expect(await page.locator('.node-card[data-node-id="check"]').innerText()).toContain('check tool');
  expect(await page.locator('.node-card[data-node-id="implement"]').getAttribute('data-node-type')).toBe('agent');
  expect(await page.locator('.node-card[data-node-id="check"]').getAttribute('data-node-type')).toBe('tool');
  await implement.click();
  // Clicking a node opens its own window; the overview there names the node.
  expect(await page.getByTestId('node-overview').innerText()).toContain('implement');
}, 60_000);

test('the Agent combination library renders and compiles recipes over filesystem capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-agent-combinations-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'research');
  const mcp = join(capabilityRoot, 'search');
  const extension = join(capabilityRoot, 'browser');
  const identity = join(capabilityRoot, 'reviewer');
  await mkdir(skill, { recursive: true });
  await mkdir(mcp, { recursive: true });
  await mkdir(extension, { recursive: true });
  await mkdir(identity, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# Research\n');
  await writeFile(join(skill, 'capability.json'), JSON.stringify({ id: 'research', kind: 'skill', version: '1.0.0', name: 'Research' }));
  await writeFile(join(mcp, 'capability.json'), JSON.stringify({ id: 'search', kind: 'mcp', version: '1.0.0', name: 'Search', url: 'https://example.com/mcp' }));
  await writeFile(join(extension, 'index.mjs'), 'export default {};\n');
  await writeFile(join(extension, 'capability.json'), JSON.stringify({ id: 'browser', kind: 'pi-extension', version: '1.0.0', name: 'Browser', entry: './index.mjs' }));
  await writeFile(join(identity, 'agent.md'), '# Reviewer\n');
  await writeFile(join(identity, 'capability.json'), JSON.stringify({ id: 'reviewer', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Reviewer' }));
  await writeFile(join(root, 'graph', 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'review', name: 'Alice_reviewer', description: '组合已有能力。', recommendedGrade: 'high', review: true, tags: ['审查'],
      resources: [
        { resourceId: 'reviewer', version: '1.0.0', role: 'identity', required: true },
        { resourceId: 'research', version: '1.0.0', role: 'skill', required: true },
        { resourceId: 'search', version: '1.0.0', role: 'mcp', required: true },
        { resourceId: 'browser', version: '1.0.0', role: 'pi-extension', required: true },
      ],
    }],
  }));
  const server = await openGraphServer({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root }],
    autoDrive: false,
    webDir,
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
  });
  cleanup.push(() => server.close());

  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/catalog/agents`);
  const list = page.getByTestId('agent-combination-list');
  await list.waitFor();
  const text = await list.innerText();
  expect(text).toContain('Alice_reviewer');
  expect(text).toContain('Reviewer');
  expect(text).toContain('Research');
  expect(text).toContain('Search');
  expect(text).toContain('Browser');
  expect(text).not.toMatch(/skill:|mcp:|prompt:/i);
  expect(await page.getByTestId('agent-capabilities-review-agent-md').innerText()).toContain('Reviewer');
  expect(await page.getByTestId('agent-capabilities-review-skills').innerText()).toContain('Research');
  expect(await page.getByTestId('agent-capabilities-review-mcp').innerText()).toContain('Search');
  expect(await page.getByTestId('agent-capabilities-review-pi-extensions').innerText()).toContain('Browser');
  for (const [id, name] of [['reviewer', 'Reviewer'], ['research', 'Research'], ['search', 'Search'], ['browser', 'Browser']] as const) {
    await page.getByTestId(`agent-capability-review-${id}`).click();
    expect(await page.getByTestId('resource-detail-drawer').innerText()).toContain(name);
    await page.getByTestId('resource-detail-close').click();
  }
  // Saving a recipe compiles it automatically: there is no manual compile button.
  expect(await page.getByRole('button', { name: '编译', exact: true }).count()).toBe(0);
  await page.getByTestId('agent-combination-review').getByRole('button', { name: '编辑' }).click();
  await page.getByTestId('agent-recipe-id').waitFor();
  await page.locator('.recipe-editor').getByRole('button', { name: '保存配方' }).click();
  await expect.poll(async () => (await page.getByTestId('toasts').innerText()).includes('已编译为 review@1')).toBe(true);
}, 60_000);

test('the graph follows real runtime events and a native budget answer authorizes an explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-m5-live-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const provider = await openaiServer([{ text: 'Reply after the user authorized more tokens.' }]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir, autoDrive: false,
    limits: { defaultBudgetTokens: 1 },
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider,
      grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  const owner = await server.runtime.user.begin({ projectId: 'p', request: 'Budget question', requestId: 'begin' });
  const main = server.runtime.supervisor(owner.taskId);
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Budget UI',
    protocols: { job: { type: 'object' } }, nodes: { work: { recipe: 'worker@1', model: 'local', task: 'Reply to the message.',
      inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } }, modules: {}, edges: {},
  }) }) as { graphId: string };
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { request: 'Answer this input after quota approval.' } });
  const browser = await chromium.launch({ headless: true }); cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${graphId}/graph`);
  await page.locator('.node-card[data-node-id="work"]').waitFor();
  await server.runtime.host.drive();
  expect(provider.requests).toHaveLength(0);
  await page.locator('.node-card[data-node-id="work"][data-status="blocked"]').waitFor();
  const blocked = await server.runtime.user.task(graphId).view();
  expect(blocked.questions.filter(question => question.kind === 'budget' && question.status === 'open')).toHaveLength(1);
  await server.runtime.host.drive();
  expect((await server.runtime.user.task(graphId).view()).questions.filter(question => question.kind === 'budget')).toHaveLength(1);
  await page.goto(`${server.url}/#/inbox`);
  await page.getByTestId('budget-tokens').fill('200000');
  const response = page.waitForResponse(r => r.url().endsWith('/answer'));
  await page.getByRole('button', { name: '答复' }).click();
  const res = await response;
  expect(res.status(), await res.text()).toBe(200);
  expect((await server.runtime.user.task(graphId).view()).questions.filter(question => question.status === 'open')).toEqual([]);
  expect(server.runtime.nodeRun(graphId, 'work').instance).toMatchObject({ authorizedBudget: { budget: 200001, unlimited: false } });
  // User authorization does not rewrite a frozen turn or replay an input by itself.
  await server.runtime.host.drive(); expect(provider.requests).toHaveLength(0);
  const queue = await main.graphInspect({ graphId, query: 'queue' }) as { items: { seq: number }[] };
  await main.graphControl({ graphId, action: 'retry', seq: queue.items[0]!.seq });
  await page.goto(`${server.url}/#/tasks/${graphId}/graph`);
  await server.runtime.host.drive();
  await page.locator('.node-card[data-node-id="work"][data-status="succeeded"]').waitFor();
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests[0])).toContain('Answer this input after quota approval.');
  const executions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { tokenBudget: { budget: number }; state: string }[] };
  expect(executions.items.map(execution => execution.tokenBudget.budget)).toEqual([1, 200001]);
  expect(server.runtime.nodeRun(graphId, 'work').instance!.used).toBeGreaterThan(0);
}, 60_000);
