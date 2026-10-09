import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-m8-rework-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});
afterAll(() => rm(webDir, { recursive: true, force: true }));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-m8-rework-ui-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function launch(): Promise<Page> {
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  return browser.newPage();
}

test('the graph refreshes native Agent and module state from task events without navigation', async () => {
  const root = await temp('live');
  const provider = await openaiServer([
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { report: 'LIVE_RESULT_VALUE' } } } }) }] },
    { text: 'Work finished' },
  ]); cleanup.push(() => provider.close());
  const server = await openGraphServer({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], webDir,
    models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] } });
  cleanup.push(() => server.close()); server.runtime.catalog.publishDefinition('coder', { recommendedGrade: 'medium' }, 'coder');
  const owner = await server.runtime.user.begin({ projectId: 'p', request: '实时记录', requestId: 'begin' }); const main = server.runtime.supervisor(owner.taskId);
  const data = { protocol: 'data' };
  const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: '实时记录', protocols: { data: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Submit the current result', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
    edges: { checked: { from: 'work.result', to: 'check.job', enabled: true } },
  }) }) as { graphId: string };
  const page = await launch(); await page.goto(`${server.url}/#/tasks/${graphId}/graph`); await page.getByTestId('graph').waitFor();
  const initialUrl = page.url();
  await page.locator('.node-card[data-node-id="work"]').waitFor();
  expect(await page.locator('.node-card[data-node-id="work"]').getAttribute('data-status')).toBe('idle');
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { request: 'Publish the live result' } });
  await server.runtime.host.drive();
  await page.locator('.node-card[data-node-id="work"][data-status="succeeded"]').waitFor();
  await page.locator('.node-card[data-node-id="check"][data-status="succeeded"]').waitFor();
  expect(page.url()).toBe(initialUrl); expect(provider.requests).toHaveLength(2);
  const edge = await main.graphInspect({ graphId, query: 'edge', id: 'checked' });
  expect(edge).toMatchObject({ latest: { report: 'LIVE_RESULT_VALUE' }, deliveries: [{ value: { report: 'LIVE_RESULT_VALUE' } }] });
  await expect(main.graphInspect({ graphId, query: 'operations' })).resolves.toMatchObject([{ state: 'settled', result: { ok: true, outputs: { result: { code: 0, passed: true } } } }]);
}, 90000);
