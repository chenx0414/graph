// graph:table-writes-exempt: the fixture writes the rows the runtime writes, so the fold can be
// proven against the real database. Nothing else is stubbed: a real daemon serves a real table.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { chromium, type Page } from 'playwright';
import { build } from 'vite';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * 洞察 is one page for the record: the billed tokens, the models behind them,
 * the tools that ran beside them and the time each side took.
 *
 * The proof is a real daemon with a real database. The rows are written the way
 * the runtime writes them, so the numbers on the page have to follow from the
 * record rather than from a fixture shaped for the page: if the aggregation and
 * the storage ever disagree, these assertions fail.
 */

let webDir: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-insights-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 120_000);
afterAll(() => rm(webDir, { recursive: true, force: true }));
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** A model call exactly as the runtime records one: usage buckets plus cost. */
/** Now, minus an offset: a row dated 1970 is a row the tool table prunes on read. */
const NOW = Date.now();
const ago = (ms: number) => NOW - ms;

function providerCall(id: string, taskId: string, model: string, usage: Record<string, number>, cost: number, ms: number) {
  return {
    id, taskId, model, ms,
    usage: JSON.stringify({ ...usage, usageSource: 'authoritative' }),
    cost: JSON.stringify({ amount: cost, currency: 'USD', unit: 'per_million_tokens' }),
    modelJson: JSON.stringify({ id: model, identity: model.split(':').pop(), provider: model.split(':')[0] }),
  };
}

const CALLS = [
  // project a: a big cached call and a small one, two tools
  providerCall('c1', 'task-a', 'opencode-go:flash', { input: 1_000, output: 200, cacheRead: 90_000, cacheWrite: 0 }, 0.5, 1_000),
  providerCall('c2', 'task-a', 'opencode-go:flash', { input: 2_000, output: 400, cacheRead: 10_000, cacheWrite: 5_000 }, 0.25, 3_000),
  // project b: one call on another model
  providerCall('c3', 'task-b', 'anthropic:sonnet', { input: 4_000, output: 800, cacheRead: 0, cacheWrite: 0 }, 1.25, 2_000),
];

async function seed(stateDir: string) {
  const db = new DatabaseSync(join(stateDir, 'tasks.sqlite'));
  db.exec(`
    INSERT INTO projects(id, root, grants) VALUES ('proj-a', '/tmp/a', '{}'), ('proj-b', '/tmp/b', '{}');
    INSERT INTO tasks(id, project_id, request, created_seq, conversation_id)
      VALUES ('task-a', 'proj-a', 'a', 1, 'conv-a'), ('task-b', 'proj-b', 'b', 2, 'conv-b');
  `);
  const insertCall = db.prepare(`INSERT INTO kernel_provider_calls
    (id, task_id, node_id, execution_id, reserved, state, usage, created_at, settled_at, model, purpose, cost)
    VALUES (?, ?, 'master', 'exec', 1, 'settled', ?, ?, ?, ?, 'completion', ?)`);
  for (const call of CALLS) {
    insertCall.run(call.id, call.taskId, call.usage, ago(call.ms + 1_000), ago(1_000), call.modelJson, call.cost);
  }
  const insertTool = db.prepare(`INSERT INTO tool_calls(instance_id, task_id, node_id, role, tool, ms, is_error, created_at)
    VALUES ('i', ?, 'master', 'master', ?, ?, ?, ?)`);
  insertTool.run('task-a', 'bash', 100, 0, ago(5_000));
  insertTool.run('task-a', 'bash', 300, 1, ago(4_000));
  insertTool.run('task-a', 'read', 50, 0, ago(3_000));
  insertTool.run('task-b', 'edit', 400, 0, ago(2_000));
  insertTool.run(null, 'template-call', 900, 0, ago(1_000));
  db.close();
}

async function open() {
  const root = await mkdtemp(join(tmpdir(), 'graph-insights-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await symlink(webDir, join(root, 'web'));
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }] }));
  await mkdir(join(root, 'graph-home', 'capabilities'), { recursive: true });
  const daemon = await launchCli(root, { configPath });
  cleanup.push(() => daemon.close());
  await seed(join(root, 'state'));
  return daemon;
}

async function insights(daemon: Awaited<ReturnType<typeof open>>, query = '') {
  const response = await daemon.request(`/api/insights${query}`);
  expect(response.status).toBe(200);
  return response.json();
}

test('folds the billed tokens, the models and the tools into one answer', async () => {
  const daemon = await open();
  const summary = await insights(daemon);

  // Two calls on one model, one on another; the buckets are the provider's own.
  expect(summary.tokens).toMatchObject({ input: 7_000, output: 1_400, cacheRead: 100_000, cacheWrite: 5_000, total: 113_400 });
  // 100000 cached reads out of 107000 prompt-side tokens.
  expect(summary.tokens.cacheHitRate).toBeCloseTo(100_000 / 107_000, 6);
  expect(summary.overview.steps).toBe(3);
  expect(summary.overview.costMicros).toBe(2_000_000);
  expect(summary.timing).toMatchObject({ modelMs: 6_000, modelCalls: 3, toolMs: 1_750, toolCalls: 5 });

  // The tool side is the same aggregate the tools page shows, per tool.
  const bash = summary.tools.find((row: { tool: string }) => row.tool === 'bash');
  expect(bash).toMatchObject({ calls: 2, errors: 1, totalMs: 400, medianMs: 200, maxMs: 300 });

  // One row per model, most expensive first.
  expect(summary.models.map((row: { model: string }) => row.model)).toEqual(['sonnet', 'flash']);
  expect(summary.models[0]).toMatchObject({ provider: 'anthropic', calls: 1, input: 4_000, output: 800, costMicros: 1_250_000 });
});

test('narrows to one project or one conversation', async () => {
  const daemon = await open();

  const project = await insights(daemon, '?scope=project&id=proj-a');
  expect(project.overview).toMatchObject({ steps: 2, toolCalls: 3, toolErrors: 1 });
  expect(project.tokens.total).toBe(108_600);
  expect(project.tools.map((row: { tool: string }) => row.tool)).toEqual(['bash', 'read']);

  const conversation = await insights(daemon, '?scope=conversation&id=conv-b');
  expect(conversation.overview).toMatchObject({ steps: 1, toolCalls: 1 });
  expect(conversation.models.map((row: { model: string }) => row.model)).toEqual(['sonnet']);

  // The merged page's folds still fetch the two older endpoints, so a clean
  // installation has to answer both of them - otherwise the detail is a fold
  // that opens onto an error card.
  for (const path of ['/api/tool-stats', '/api/skill-stats']) {
    const response = await daemon.request(path);
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
  }

  // A scope that names nothing is an error, not a silent whole-installation number.
  const refused = await daemon.request('/api/insights?scope=project');
  expect(refused.status).toBeGreaterThanOrEqual(400);
});

/** The page has to show what the endpoint says, in the same words. */
async function page(daemon: Awaited<ReturnType<typeof open>>, hash: string) {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const tab = await browser.newPage();
  await tab.goto(`${daemon.url}/${hash}`);
  return tab;
}

async function text(tab: Page, testid: string): Promise<string> {
  await expect.poll(async () => (await tab.getByTestId(testid).count())).toBeGreaterThan(0);
  return (await tab.getByTestId(testid).innerText()).replace(/\s+/g, ' ').trim();
}

test('renders the record, and the old two pages now open it', async () => {
  const daemon = await open();
  const tab = await page(daemon, '#/insights');

  const overview = await text(tab, 'insights-overview');
  expect(overview).toContain('模型调用 3');
  expect(overview).toContain('工具调用 5');
  // The tokens card names every bucket it drew.
  expect(await text(tab, 'insights-legend-cacheRead')).toContain('100.0k');
  expect(await text(tab, 'insights-cache')).toContain('缓存命中 93.5%');
  // The tool table carries the same rows the endpoint returned.
  expect(await text(tab, 'insights-tool-row-bash')).toContain('2');
  expect(await text(tab, 'insights-model-flash')).toContain('2');

  // The two long sections are folds, and closed has to mean not mounted: the
  // subscription and skill queries only run when someone asks for them.
  for (const id of ['quota', 'detail']) {
    expect(await tab.getByTestId(`insights-fold-${id}`).getAttribute('data-open')).toBe('false');
    expect(await tab.getByTestId(`insights-fold-${id}-body`).count()).toBe(0);
  }
  await tab.getByTestId('insights-fold-detail-toggle').click();
  await expect.poll(async () => (await tab.getByTestId('insights-fold-detail-body').count())).toBe(1);
  // Opening it reveals the tool detail the page used to be.
  await expect.poll(async () => (await tab.getByTestId('tool-stats-row-bash').count())).toBeGreaterThan(0);

  // `/tools` is the merged page now: the address still works and lands on 洞察.
  await tab.goto(`${daemon.url}/#/tools`);
  await expect.poll(() => tab.evaluate(() => window.location.hash)).toBe('#/insights');
  await expect.poll(async () => (await tab.getByTestId('insights-page').count())).toBe(1);
}, 120_000);
