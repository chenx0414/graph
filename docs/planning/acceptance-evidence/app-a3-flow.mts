/**
 * APP A3 evidence probe: drives a controlled task to completion, then opens
 * the real console to assert and screenshot the run timeline, usage summary,
 * coloured graph with minimap, and the question inbox.
 * Run: export PATH="$PWD/node_modules/.bin:$PATH"; node docs/planning/acceptance-evidence/app-a3-flow.mts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openGraphServer } from '../../../src/server/host.ts';

const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };
const root = await mkdtemp(join(tmpdir(), 'graph-a3-evidence-'));
const actions = {
  work: { kind: 'agent' as const, reserveTokens: 100, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage }) },
  workSmall: { kind: 'agent' as const, reserveTokens: 10, prepare: async () => async () => ({ outcome: 'completed' as const, output: { done: true }, usage }) },
  check: { kind: 'program' as const, prepare: async () => async () => ({ outcome: 'completed' as const, output: { passed: true }, evidence: [{ acceptanceId: 'works', summary: '检查通过', artifact: { path: join(root, 'ok.txt'), digest: 'a'.repeat(64) } }] }) },
};
const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir: new URL('../../../dist/web', import.meta.url).pathname, actions });
server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
const nodes = [
  { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program' as const, action: 'check', dependsOn: ['work'] },
];
const first = await server.runtime.user.begin({ projectId: 'p', request: 'A3 证据任务', requestId: 'a3-begin' });
await server.runtime.supervisor(first.taskId).propose({ requirementVersion: 1, summary: '证据', acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }], nodes }, 'a3-proposal');
await server.runtime.user.task(first.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'a3-accept' });
for (let i = 0; i < 80; i++) {
  await server.runtime.host.runReady();
  if ((await server.runtime.user.task(first.taskId).view()).phase === 'completed') break;
  await new Promise(r => setTimeout(r, 100));
}

const second = await server.runtime.user.begin({ projectId: 'p', request: 'A3 收件箱任务', requestId: 'a3-begin-2' });
await server.runtime.supervisor(second.taskId).propose({ requirementVersion: 1, summary: '收件箱', acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }], nodes: [
  { id: 'work', kind: 'agent' as const, action: 'workSmall', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program' as const, action: 'check', dependsOn: ['work'] },
] }, 'a3-proposal-2');
await server.runtime.user.task(second.taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'a3-accept-2' });
// The second task uses a tiny reservation so the settle opens a budget question.
await server.runtime.host.runReady();
for (let i = 0; i < 60; i++) {
  const view = await server.runtime.user.task(second.taskId).view();
  if (view.questions.some(question => question.status === 'open')) break;
  await server.runtime.host.runReady();
  await new Promise(r => setTimeout(r, 100));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${server.url}/#/tasks/${first.taskId}`);
await page.getByTestId('timeline').waitFor();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline"] li').length > 0);
const timelineCount = await page.locator('[data-testid="timeline"] li').count();
const usageText = await page.getByTestId('usage-summary').innerText();
await page.screenshot({ path: new URL('./app-a3-task.png', import.meta.url).pathname });
await page.goto(`${server.url}/#/tasks/${first.taskId}/graph`);
await page.locator('.react-flow__minimap').waitFor();
const minimap = await page.locator('.react-flow__minimap').isVisible();
const nodeCount = await page.locator('.react-flow__node').count();
await page.screenshot({ path: new URL('./app-a3-graph.png', import.meta.url).pathname });
await page.goto(`${server.url}/#/inbox`);
await page.getByTestId('inbox').waitFor();
await page.waitForFunction(() => document.querySelector('[data-testid="inbox"]')?.textContent?.includes('reservation_exceeded'));
const inboxText = await page.getByTestId('inbox').innerText();
await page.screenshot({ path: new URL('./app-a3-inbox.png', import.meta.url).pathname });
// Synthetic 100-node graph: measure first paint through the real React Flow page.
await page.route(`**/api/tasks/${first.taskId}/graph*`, async route => {
  const nodes = Array.from({ length: 100 }, (_, index) => ({
    id: `n${index}`,
    kind: index % 4 === 0 ? 'program' : 'agent',
    status: index % 3 === 0 ? 'succeeded' : index % 3 === 1 ? 'preparing' : 'pending',
    used: index % 3 === 0 ? 10 : null, budget: null, reserved: 0,
    instanceId: null, selectedModel: 'scripted', boundDefinition: 'coder@1',
  }));
  const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const edges: { id: string; source: string; target: string }[] = [];
  nodes.forEach((node, index) => {
    positions[node.id] = { x: (index % 10) * 200, y: Math.floor(index / 10) * 120, width: 160, height: 40 };
    if (index > 0) edges.push({ id: `e${index}`, source: `n${index - 1}`, target: node.id });
  });
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nodes, containers: [], loops: [], revisions: [{ version: 1, reason: 'perf' }], layout: { positions, edges }, cost: { unknown: false, amount: 0 } }) });
});
const paintStarted = Date.now();
await page.goto(`${server.url}/?perf=1#/tasks/${first.taskId}/graph`);
await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 100);
const hundredNodeFirstPaintMs = Date.now() - paintStarted;
await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({
  timelineEntries: timelineCount,
  usageSummary: usageText.replace(/\n/g, ' '),
  minimapVisible: minimap,
  graphNodes: nodeCount,
  inboxShows: inboxText.split('\n').filter(line => line.includes('reservation') || line.includes('待处理')).slice(0, 3),
  hundredNodeFirstPaintMs,
}, null, 1));
