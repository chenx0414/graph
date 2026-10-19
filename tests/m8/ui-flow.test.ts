import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { nextEventCursor } from '../../src/web/event-cursor.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-flow-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-ui-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function launch() {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  return browser;
}

test('cursor helpers ignore duplicates and out-of-order frames', () => {
  expect(nextEventCursor(0, { cursor: 3, type: 'task.created' })).toMatchObject({ cursor: 3, type: 'task.created', data: {} });
  // The full payload survives so the timeline can label the event.
  expect(nextEventCursor(0, { cursor: 5, type: 'x', data: { nodeId: 'work' }, timestamp: 123 })).toEqual({ cursor: 5, type: 'x', data: { nodeId: 'work' }, timestamp: 123 });
  expect(nextEventCursor(3, { cursor: 3, type: 'task.created' })).toBeNull();
  expect(nextEventCursor(3, { cursor: 2, type: 'task.created' })).toBeNull();
  expect(nextEventCursor(3, { cursor: 4.5, type: 'x' })).toBeNull();
  expect(nextEventCursor(3, { type: 'x' })).toBeNull();
  expect(nextEventCursor(3, null)).toBeNull();
});

test('the console completes the main flow, keeps projects separate, and restores a direct graph URL', async () => {
  const rootA = await temp('flow-a');
  const rootB = await temp('flow-b');
  let reference: () => { artifactId: string; version: number; digest: string };
  const provider = await openaiServer([
    { tools: [{ id: 'publish', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'plans', name: 'candidate', content: 'PROJECT_A_VERSION_ONE', requestId: 'candidate-v1' }) }] },
    { tools: [{ id: 'publish', name: 'submit', arguments: () => JSON.stringify({ outputs: { result: { enable: true, value: { report: 'PROJECT_A_RESULT', appendix: 'x'.repeat(12000) + 'LAZY_VALUE_END', subject: reference() } } } }) }] },
    { text: 'Completed project A ' + 'x'.repeat(12000) + 'LAZYLOGEND' },
  ]); cleanup.push(() => provider.close());
  const server = await openGraphServer({ stateDir: join(rootA, 'state'), projects: [{ id: 'project-a', root: rootA }, { id: 'project-b', root: rootB }],
    autoDrive: false, webDir, startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => server.close()); server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const data = { protocol: 'data' };
  const define = (name: string) => parseGraphDefinition({ schemaVersion: 2, name, protocols: { data: { type: 'object' } },
    nodes: { implement: { recipe: 'coder@1', model: 'local', task: name, inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
    edges: { check: { from: 'implement.result', to: 'check.job', enabled: true } } });
  const browser = await launch();
  const page = await browser.newPage();

  const ownerA = await server.runtime.user.begin({ projectId: 'project-a', request: '任务 A：实现搜索', requestId: 'begin-a' }); const mainA = server.runtime.supervisor(ownerA.taskId);
  const taskA = ((await mainA.graphCreate({ definition: define('任务 A：实现搜索') })) as { graphId: string }).graphId;
  reference = () => { const record = server.runtime.artifacts.list(taskA, { namespace: 'plans' }).artifacts[0]!; return { artifactId: record.artifactId, version: record.version, digest: record.digest }; };
  await mainA.graphSend({ graphId: taskA, nodeId: 'implement', input: 'job', value: { request: 'Project A search' } }); await server.runtime.host.drive();
  expect(provider.requests).toHaveLength(3);
  // A task opens on its graph now; the node cards carry the state the task page used to print.
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.locator('.node-card[data-node-id="check"][data-status="succeeded"]').waitFor();
  await page.locator('.node-card[data-node-id="implement"][data-status="succeeded"]').waitFor();
  // The real submission's provenance and downstream processing are visible on its edge.
  const graphFacts = await (await page.request.get(`${server.url}/api/tasks/${taskA}/graph`)).json() as {
    interfaces: { edgeId: string; deliveries: { sourceExecutionId: string | null; receiver: { state: string } }[] }[];
  };
  const sent = graphFacts.interfaces.find(edge => edge.edgeId === 'check')!.deliveries[0]!;
  expect(sent.sourceExecutionId).toMatch(/^exec-/);
  expect(sent.receiver.state).toBe('settled');
  const checkPath = page.locator('[data-testid="rf__edge-check"] .react-flow__edge-path');
  const visibleCheckPoint = () => checkPath.evaluate(element => {
    const path = element as SVGPathElement;
    for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction).matrixTransform(path.getScreenCTM()!);
      if (document.elementFromPoint(point.x, point.y)?.closest('[data-testid="rf__edge-check"]')) return { x: point.x, y: point.y };
    }
    return null;
  });
  await expect.poll(visibleCheckPoint).not.toBeNull();
  const checkPoint = (await visibleCheckPoint())!;
  await page.mouse.click(checkPoint.x, checkPoint.y);
  await expect.poll(() => page.getByTestId('graph-edge-inspector').innerText()).toContain(sent.sourceExecutionId!);
  expect(await page.getByTestId('graph-edge-inspector').innerText()).toContain('接收状态：settled');
  expect(JSON.stringify(graphFacts)).not.toContain('LAZY_VALUE_END');
  await page.getByTestId('graph-edge-inspector').getByRole('button', { name: '读取完整 value', exact: true }).click();
  await expect.poll(() => page.getByTestId('graph-edge-inspector').innerText()).toContain('LAZY_VALUE_END');
  const artifactLink = page.getByTestId('graph-edge-inspector').getByRole('link', { name: `产物 ${reference().artifactId} · v1`, exact: true });
  expect(await artifactLink.getAttribute('href')).toBe(`#/tasks/${taskA}/artifacts/${reference().artifactId}?v=1`);
  await artifactLink.click();
  await expect.poll(() => page.getByTestId('artifact-tab').innerText()).toContain('PROJECT_A_VERSION_ONE');
  await page.locator('.tab[data-kind="artifact"] .tab-close').first().click();
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.getByTestId('graph').waitFor();

  if (await page.getByTestId('graph-edge-inspector').isVisible()) await page.getByRole('button', { name: '关闭边详情' }).click();
  const edgeByKeyboard = page.getByTestId('rf__edge-check');
  await edgeByKeyboard.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('graph-edge-inspector').waitFor();
  await page.getByRole('button', { name: '关闭边详情' }).click();
  const nodeByKeyboard = page.locator('.react-flow__node').filter({ hasText: 'implement' }).first();
  await nodeByKeyboard.focus();
  await page.keyboard.press('Enter');
  // A node opens its own tab; the overview states what it is, and the graph keeps the state.
  await expect.poll(() => page.getByTestId('node-overview').innerText()).toContain('implement');
  await expect.poll(() => page.getByTestId('node-environment').innerText()).toContain(rootA);
  expect(await page.getByTestId('node-environment').innerText()).toContain('受限访问');
  const summary = await (await page.request.get(`${server.url}/api/tasks/${taskA}/nodes/implement/run?limit=1`)).json();
  expect(summary).toMatchObject({ toolCallCount: 2 });
  expect(summary.entries).toHaveLength(1);
  expect(JSON.stringify(summary)).not.toContain('LAZYLOGEND');
  expect(summary.entries[0]).toMatchObject({ contentTruncated: true });
  expect(JSON.stringify(server.runtime.events(taskA).filter(event => event.type === 'node.entry'))).not.toContain('LAZYLOGEND');
  const logEntryId = summary.entries[0].id as string;
  await page.getByTestId(`node-read-entry-${logEntryId}`).click();
  await expect.poll(() => page.getByTestId('node-message-list').innerText()).toContain('LAZYLOGEND');
  expect(await page.getByTestId(`node-read-entry-${logEntryId}`).count()).toBe(0);

  const toolCount = page.getByTestId('node-overview').locator('.stat').filter({ has: page.getByText('工具调用', { exact: true }) });
  await expect.poll(() => toolCount.innerText()).toContain('2');
  const measuredRun = page.getByTestId('node-overview').locator('.stat').filter({ has: page.getByText('运行', { exact: true }) });
  await expect.poll(() => measuredRun.innerText()).not.toContain('未记录');
  expect(await measuredRun.innerText()).toContain('不含名额等待');
  await page.locator('summary[aria-label="System prompt"]').click();
  await expect.poll(() => page.getByTestId('node-configurations').innerText()).toContain('当前执行配置：coder@1');
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium', systemPrompt: 'Next turn configuration' }, 'coder-next');
  await mainA.graphPatch({ graphId: taskA, baseRevision: 1, changes: { reason: 'Update the next turn while the chat remains open', patch: { nodes: { implement: { recipe: 'coder@2' } } } } });
  await expect.poll(() => page.getByTestId('node-configurations').innerText()).toContain('下一次执行配置：coder@2（有待生效修改）');
  expect(await page.getByTestId('node-configurations').innerText()).toContain('当前执行配置：coder@1');
  expect(await page.getByTestId('node-prompt-sent-text').innerText()).not.toContain('Next turn configuration');
  await mainA.graphControl({ graphId: taskA, action: 'complete' }); await server.runtime.host.drive();
  expect((await server.runtime.user.task(taskA).view()).phase).toBe('completed');
  await page.locator('.tab[data-kind="node"] .tab-close').first().click();
  await page.locator('.node-card[data-node-id="implement"][data-status="succeeded"]').waitFor();
  await page.getByTestId('legend').waitFor();

  // A second project and task must not mix data with the first.
  const ownerB = await server.runtime.user.begin({ projectId: 'project-b', request: '任务 B：修复导出', requestId: 'begin-b' });
  const secondDefinition = define('任务 B：修复导出');
  secondDefinition.nodes['human-worker'] = secondDefinition.nodes.implement!; delete secondDefinition.nodes.implement;
  secondDefinition.edges.check!.from = 'human-worker.result';
  const taskB = ((await server.runtime.supervisor(ownerB.taskId).graphCreate({ definition: secondDefinition })) as { graphId: string }).graphId;
  expect((await server.runtime.user.task(taskB).view()).nodes.find(node => node.id === 'human-worker')!.status).toBe('idle');
  const wrongNode = await page.request.get(`${server.url}/api/tasks/${taskB}/nodes/human-worker/run?entryId=${logEntryId}`);
  expect(wrongNode.status()).toBe(400);
  expect(await wrongNode.json()).toMatchObject({ code: 'not_found', message: 'Entry does not belong to this node' });
  await expect(server.runtime.supervisor(ownerB.taskId).graphInspect({ graphId: taskA })).rejects.toMatchObject({ code: 'permission' });
  expect(taskB).not.toBe(taskA);
  // Which task is in front is read from its window: the active task-graph tab is named
  // after the task, so one project's task cannot show up under another's name.
  const activeGraphTab = '.tab[data-kind="graph"][data-active="true"] .tab-title';
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('任务 A'), activeGraphTab);
  await page.goto(`${server.url}/#/tasks/${taskB}/graph`);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('任务 B'), activeGraphTab);
  expect(await page.locator(activeGraphTab).first().innerText()).not.toContain('任务 A');
  await expect.poll(() => page.locator('.node-card[data-node-id="human-worker"]').getAttribute('data-node-type')).toBe('agent');
  // A direct reload of the graph address restores the page.
  await page.goto(`${server.url}/#/tasks/${taskA}/graph`);
  await page.reload();
  await page.getByTestId('graph').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 2);
}, 90_000);

test('parallel branches, subgraphs and rework back-edges render and errors are explicit', async () => {
  const root = await temp('complex');
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'project', root }],
    autoDrive: false, webDir,
    startup: { mode: 'execute', configured: true, modelCount: 1, enabledModelCount: 1 },
  });
  cleanup.push(() => server.close());
  server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const owner = await server.runtime.user.begin({ projectId: 'project', request: '复杂图', requestId: 'begin' }); const main = server.runtime.supervisor(owner.taskId);
  const data = { protocol: 'data' }; const leaf = { recipe: 'coder@1', task: 'Process the explicit input', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } };
  const { graphId: taskId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: '并行与反馈', protocols: { data: { type: 'object' } }, nodes: {}, modules: { feed: { type: 'router', trigger: 'each', inputs: { job: data }, outputs: { result: data }, rules: [{ when: 'true', emit: { result: '$job' } }] } }, edges: { history: { from: 'feed.result', to: 'grp.start', enabled: true }, 'public-result': { from: 'grp.result', to: 'feed.job', enabled: true }, 'loop:feedback': { from: 'grp/join.result', to: 'grp/left.job', enabled: true } },
    templates: { branches: { version: 1, definition: { schemaVersion: 2, name: 'Reusable parallel join', protocols: { data: { type: 'object' } },
      nodes: { left: leaf }, templates: { single: { version: 1, definition: { schemaVersion: 2, name: 'Nested branch', protocols: { data: { type: 'object' } }, nodes: { right: leaf }, modules: {}, edges: {}, inputs: { job: { to: 'right.job', protocol: 'data' } }, outputs: { result: { from: 'right.result', protocol: 'data' } } } } }, instances: { branch: { template: 'single', version: 1 } }, modules: { join: { type: 'router', trigger: 'once', requiredInputs: ['left', 'right'], inputs: { left: data, right: data }, outputs: { result: data },
        rules: [{ when: 'true', emit: { result: { left: '$left', right: '$right' } } }] } },
      edges: { leftJoin: { from: 'left.result', to: 'join.left', enabled: true }, rightJoin: { from: 'branch.result', to: 'join.right', enabled: true }, feedback: { from: 'join.result', to: 'left.job', enabled: true } },
      inputs: { start: { to: 'left.job', protocol: 'data' } }, outputs: { result: { from: 'join.result', protocol: 'data' } },
    } } }, instances: { grp: { template: 'branches', version: 1 } },
  }) }) as { graphId: string };
  for (const nodeId of ['grp/left', 'grp/branch/right']) await main.graphControl({ graphId: taskId, nodeId, action: 'pause' });
  for (let n = 1; n <= 25; n++) await main.graphSend({ graphId: taskId, nodeId: 'feed', input: 'job', value: { historyMarker: `DELIVERY_${n}`, ...(n === 25 ? { appendix: 'x'.repeat(12000) + 'MODULE_VALUE_END' } : {}) } });
  await server.runtime.host.drive();
  await server.runtime.sendPeerMessage(taskId, 'grp/left', { to: 'grp/branch/right', text: 'Compare these independent findings.', requestId: 'visible-peer' });
  const browser = await launch();
  const page = await browser.newPage();
  await page.goto(`${server.url}/#/tasks/${taskId}/graph`);
  await page.getByTestId('graph').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 4);
  await page.locator('[data-testid="rf__edge-message:grp/left:grp/branch/right"] .react-flow__edge-path').waitFor({ state: 'attached' });
  const messagePath = page.locator('[data-testid="rf__edge-message:grp/left:grp/branch/right"] .react-flow__edge-path');
  const visibleMessagePoint = (elementPath = messagePath, edgeId = 'message:grp/left:grp/branch/right') => elementPath.evaluate((element, edgeId) => {
    const path = element as SVGPathElement;
    for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction).matrixTransform(path.getScreenCTM()!);
      if (document.elementFromPoint(point.x, point.y)?.closest(`[data-testid="rf__edge-${edgeId}"]`)) return { x: point.x, y: point.y };
    }
    return null;
  }, edgeId);
  await expect.poll(() => visibleMessagePoint()).not.toBeNull();
  const messagePoint = (await visibleMessagePoint())!;
  await page.mouse.click(messagePoint.x, messagePoint.y);
  await expect.poll(() => page.getByTestId('graph-edge-inspector').innerText()).toContain('Compare these independent findings.');

  const historyPath = page.locator('[data-testid="rf__edge-history"] .react-flow__edge-path');
  const visibleHistoryPoint = () => historyPath.evaluate(element => {
    const path = element as SVGPathElement;
    for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction).matrixTransform(path.getScreenCTM()!);
      if (document.elementFromPoint(point.x, point.y)?.closest('[data-testid="rf__edge-history"]')) return { x: point.x, y: point.y };
    }
    return null;
  });
  await expect.poll(visibleHistoryPoint).not.toBeNull();
  const historyPoint = (await visibleHistoryPoint())!; await page.mouse.click(historyPoint.x, historyPoint.y);
  const historyPanel = page.getByTestId('graph-edge-inspector');
  await expect.poll(() => historyPanel.locator('li').count()).toBe(20);
  const firstPage = await (await page.request.get(`${server.url}/api/tasks/${taskId}/graph/edges/history?limit=20`)).json() as { deliveries: { id: string }[]; nextBefore: number };
  expect(firstPage.deliveries).toHaveLength(20);
  expect((await page.request.get(`${server.url}/api/tasks/${taskId}/graph/edges/history?limit=201`)).status()).toBe(400);
  expect((await page.request.get(`${server.url}/api/tasks/${taskId}/graph/edges/${encodeURIComponent('loop:feedback')}/deliveries/${firstPage.deliveries[0]!.id}`)).status()).toBe(400);
  await historyPanel.getByRole('button', { name: '加载更早投递', exact: true }).click();
  await expect.poll(() => historyPanel.locator('li').count()).toBe(25);
  expect(await historyPanel.innerText()).toContain('DELIVERY_1');
  await historyPanel.getByRole('button', { name: '读取完整 value', exact: true }).click();
  await expect.poll(() => historyPanel.innerText()).toContain('DELIVERY_25');
  expect(await historyPanel.getByRole('button', { name: '加载更早投递', exact: true }).count()).toBe(0);

  const feedbackPath = page.locator('[data-testid="rf__edge-grp/feedback"] .react-flow__edge-path');
  await feedbackPath.waitFor({ state: 'attached' }); expect(await feedbackPath.getAttribute('d')).not.toMatch(/[CQ]/);
  // Edge IDs are opaque: a legacy-looking ID must still render the server's native route.
  const graphResponse = await page.request.get(`${server.url}/api/tasks/${taskId}/graph`);
  expect(graphResponse.status()).toBe(200);
  const structure = await graphResponse.json() as { layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; points: { x: number; y: number }[] }[] } };
  const route = structure.layout.edges.find(edge => edge.id === 'loop:feedback')!;
  expect(route.points.length).toBeGreaterThan(1);
  const nativePath = `M ${route.points[0]!.x} ${route.points[0]!.y} ${route.points.slice(1).map(point => `L ${point.x} ${point.y}`).join(' ')}`;
  const opaquePath = page.locator('[data-testid="rf__edge-loop:feedback"] .react-flow__edge-path');
  await expect.poll(() => opaquePath.getAttribute('d')).toBe(nativePath);

  await expect.poll(async () => {
    const container = await page.locator('.react-flow__node[data-id="grp"]').boundingBox();
    const left = await page.locator('.react-flow__node[data-id="grp/left"]').boundingBox();
    return Boolean(container && left
      && container.x <= left.x
      && container.y <= left.y
      && container.x + container.width >= left.x + left.width
      && container.y + container.height >= left.y + left.height);
  }).toBe(true);
  const moduleOverview = await (await page.request.get(`${server.url}/api/tasks/${taskId}/graph`)).json() as { modules: unknown[] };
  expect(JSON.stringify(moduleOverview.modules)).not.toContain('MODULE_VALUE_END');
  await page.locator('.react-flow__node').filter({ hasText: 'feed' }).first().click();
  const modulePanel = page.getByTestId('graph-module-inspector');
  expect(await page.getByTestId('graph-edge-inspector').count()).toBe(0);
  await expect.poll(() => modulePanel.getByTestId('module-transition').count()).toBe(20);
  const modulePage = await (await page.request.get(`${server.url}/api/tasks/${taskId}/graph/modules/feed?limit=20`)).json() as { transitions: { id: string }[]; nextAfter: number };
  expect(modulePage.transitions).toHaveLength(20);
  expect((await page.request.get(`${server.url}/api/tasks/${taskId}/graph/modules/feed?after=-1`)).status()).toBe(400);
  expect((await page.request.get(`${server.url}/api/tasks/${taskId}/graph/modules/${encodeURIComponent('grp/join')}/transitions/${modulePage.transitions[0]!.id}`)).status()).toBe(400);
  await modulePanel.getByRole('button', { name: '加载更多判断记录', exact: true }).click();
  await expect.poll(() => modulePanel.getByTestId('module-transition').count()).toBe(25);
  await modulePanel.getByRole('button', { name: '读取完整判断记录', exact: true }).click();
  await expect.poll(() => modulePanel.getByTestId('module-transition').last().innerText()).toContain('MODULE_VALUE_END');
  await modulePanel.getByRole('button', { name: '读取完整输入与状态', exact: true }).click();
  await expect.poll(() => modulePanel.getByTestId('module-inputs').innerText()).toContain('MODULE_VALUE_END');
  const nodesBeforeFold = await main.graphInspect({ graphId: taskId, query: 'nodes' });
  const moduleBeforeFold = await main.graphInspect({ graphId: taskId, query: 'module', id: 'feed' });
  await page.getByTestId('container-grp/branch').click();
  await expect.poll(() => page.locator('.node-card[data-node-id="grp/branch/right"]').count()).toBe(0);
  expect(await page.getByTestId('subgraph-ports-grp/branch').innerText()).toContain('job');
  await expect.poll(() => page.locator('[data-testid="rf__edge-message:grp/left:grp/branch"] .react-flow__edge-path').count()).toBe(1);
  const foldedMessagePath = page.locator('[data-testid="rf__edge-message:grp/left:grp/branch"] .react-flow__edge-path');
  await expect.poll(() => visibleMessagePoint(foldedMessagePath, 'message:grp/left:grp/branch')).not.toBeNull();
  const foldedMessagePoint = (await visibleMessagePoint(foldedMessagePath, 'message:grp/left:grp/branch'))!;
  await page.mouse.click(foldedMessagePoint.x, foldedMessagePoint.y);
  await expect.poll(() => page.getByTestId('graph-edge-inspector').innerText()).toContain('grp/left → grp/branch/right');
  expect(await page.getByTestId('graph-edge-inspector').innerText()).toContain('Compare these independent findings.');

  await page.getByTestId('container-grp').click();
  await expect.poll(() => page.locator('.node-card[data-node-id="grp/left"]').count()).toBe(0);
  expect(await page.locator('.react-flow__node[data-id="grp/branch"]').count()).toBe(0);
  const publicPorts = page.getByTestId('subgraph-ports-grp');
  expect(await publicPorts.count()).toBe(1);
  expect(await publicPorts.innerText()).toContain('start');
  expect(await publicPorts.innerText()).toContain('result');
  expect(await publicPorts.innerText()).toContain('data@1');
  expect(await page.locator('.react-flow__node[data-id="grp"]').innerText()).toContain('branches@1');
  const boxes = [structure.layout.positions.feed!, structure.layout.positions.grp!];
  for (const edgeId of ['history', 'public-result']) {
    const path = page.locator(`[data-testid="rf__edge-${edgeId}"] .react-flow__edge-path`);
    await expect.poll(() => path.getAttribute('d')).toMatch(/^M /);
    const drawn = (await path.getAttribute('d'))!;
    expect(drawn).not.toMatch(/[CQ]/);
    const coordinates = drawn.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(coordinates.every(coordinate => Math.abs(coordinate % 16) === 0)).toBe(true);
    const points = Array.from({ length: coordinates.length / 2 }, (_, index) => ({ x: coordinates[index * 2]!, y: coordinates[index * 2 + 1]! }));
    const source = edgeId === 'history' ? boxes[0]! : boxes[1]!;
    const target = edgeId === 'history' ? boxes[1]! : boxes[0]!;
    expect(points[0]).toEqual({ x: source.x + source.width / 2, y: source.y + source.height });
    expect(points.at(-1)).toEqual({ x: target.x + target.width / 2, y: target.y });
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1]!, to = points[index]!;
      expect(from.x === to.x || from.y === to.y).toBe(true);
      for (const box of boxes) {
        const crosses = from.x === to.x
          ? from.x > box.x && from.x < box.x + box.width && Math.min(from.y, to.y) < box.y + box.height && Math.max(from.y, to.y) > box.y
          : from.y > box.y && from.y < box.y + box.height && Math.min(from.x, to.x) < box.x + box.width && Math.max(from.x, to.x) > box.x;
        expect(crosses, `${edgeId} crosses a visible node`).toBe(false);
      }
    }
  }
  expect(await page.locator('[data-testid="rf__edge-loop:feedback"]').count()).toBe(0);
  const foldedPath = page.locator('[data-testid="rf__edge-history"] .react-flow__edge-path');
  const visibleFoldedPoint = () => foldedPath.evaluate(element => {
    const path = element as SVGPathElement;
    for (const fraction of [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]) {
      const point = path.getPointAtLength(path.getTotalLength() * fraction).matrixTransform(path.getScreenCTM()!);
      if (document.elementFromPoint(point.x, point.y)?.closest('[data-testid="rf__edge-history"]')) return { x: point.x, y: point.y };
    }
    return null;
  });
  await expect.poll(visibleFoldedPoint).not.toBeNull();
  const foldedPoint = (await visibleFoldedPoint())!;
  await page.mouse.click(foldedPoint.x, foldedPoint.y);
  const foldedInspector = page.getByTestId('graph-edge-inspector');
  await expect.poll(() => foldedInspector.innerText()).toContain('折叠连接：feed.result → grp.start');
  await foldedInspector.getByRole('button', { name: '读取完整 value', exact: true }).click();
  await expect.poll(() => foldedInspector.innerText()).toContain('DELIVERY_25');
  const preserved = await (await page.request.get(`${server.url}/api/tasks/${taskId}/graph`)).json() as typeof structure;
  expect(preserved.layout).toEqual(structure.layout);


  await page.getByTestId('container-grp').click();
  await page.locator('.node-card[data-node-id="grp/left"]').waitFor();
  expect(await page.getByTestId('subgraph-ports-grp/branch').count()).toBe(1);
  expect(await page.locator('.node-card[data-node-id="grp/branch/right"]').count()).toBe(0);
  await page.getByTestId('container-grp/branch').click();
  await page.locator('.node-card[data-node-id="grp/branch/right"]').waitFor();
  await expect.poll(() => opaquePath.getAttribute('d')).toBe(nativePath);
  expect(await main.graphInspect({ graphId: taskId, query: 'nodes' })).toEqual(nodesBeforeFold);
  expect(await main.graphInspect({ graphId: taskId, query: 'module', id: 'feed' })).toEqual(moduleBeforeFold);

  const unchangedState = await main.graphInspect({ graphId: taskId, query: 'nodes' });
  const unchangedModule = await main.graphInspect({ graphId: taskId, query: 'module', id: 'feed' });
  const relayoutResponse = page.waitForResponse(response => response.url().endsWith(`/api/tasks/${taskId}/graph/control`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '重新布局', exact: true }).click();
  const relayout = await relayoutResponse;
  expect(relayout.status()).toBe(200); expect(await relayout.json()).toEqual({ state: 'layout_reset' });
  expect(await main.graphInspect({ graphId: taskId, query: 'nodes' })).toEqual(unchangedState);
  expect(await main.graphInspect({ graphId: taskId, query: 'module', id: 'feed' })).toEqual(unchangedModule);

  // Explicit errors: an unknown task and a synthetic 500 never hang on loading.
  await page.goto(`${server.url}/#/tasks/missing-task`);
  await page.getByTestId('error').filter({ visible: true }).waitFor();
  expect(await page.getByTestId('error').filter({ visible: true }).innerText()).not.toContain('加载中');
  await page.route('**/api/tasks/broken-task**', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: '合成服务器错误' }) }));
  await page.goto(`${server.url}/#/tasks/broken-task`);
  await page.getByTestId('error').filter({ visible: true }).waitFor();
  expect(await page.getByTestId('error').filter({ visible: true }).innerText()).toContain('合成服务器错误');
}, 90_000);
