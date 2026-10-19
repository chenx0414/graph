/** Real HTTP/SQLite/browser performance and parity guard. No application mocks. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const baseline = resolve(process.argv[2] ?? '/tmp/graph-flash-baseline-web');
const candidate = resolve(process.argv[3] ?? 'dist/web');
const output = resolve(process.argv[4] ?? 'perf/bench/paired.json');
const throttled = process.env.PERF_PROFILE !== 'local';
const runs = Number(process.env.PERF_RUNS ?? 10);
assert.ok(Number.isInteger(runs) && runs >= 10);
const root = await mkdtemp(join(tmpdir(), 'graph-flash-'));
const servers: Awaited<ReturnType<typeof openGraphServer>>[] = [];
const browser = await chromium.launch();
const results: Record<string, unknown[]> = { A: [], B: [] };
try {
  for (const [label, webDir] of [['A', baseline], ['B', candidate]]) {
    const stateDir = join(root, label!);
    await mkdir(stateDir);
    const server = await openGraphServer({ stateDir, webDir: webDir!, projects: [], startup: { mode: 'view', configured: true, modelCount: 0, enabledModelCount: 0 } });
    servers.push(server);
    const conversation = await server.runtime.conversations.create({ title: '性能验证会话', text: '保存的性能验证消息', requestId: 'perf-chat' });
    const graph = await server.runtime.supervisor(conversation.taskId).graphCreate({ definition: parseGraphDefinition({
      schemaVersion: 2, name: '性能验证任务图', protocols: { data: { type: 'object' } }, nodes: {},
      modules: { first: { type: 'router', trigger: 'each', rules: [{ when: 'true', emit: { output: '$input' } }], inputs: { input: { protocol: 'data' } }, outputs: { output: { protocol: 'data' } } },
        second: { type: 'router', trigger: 'each', rules: [{ when: 'true', emit: { output: '$input' } }], inputs: { input: { protocol: 'data' } }, outputs: { output: { protocol: 'data' } } } },
      edges: { wire: { enabled: true, from: 'first.output', to: 'second.input' } },
    }) });
    assert.ok(graph && typeof graph === 'object' && 'graphId' in graph && typeof graph.graphId === 'string');
    Object.assign(server, { perfConversation: conversation.conversationId, perfGraph: graph.graphId });
  }
  for (let run = 0; run < runs; run++) {
    for (let index = 0; index < servers.length; index++) {
      const server = servers[index]! as typeof servers[number] & { perfConversation: string; perfGraph: string };
      const label = index ? 'B' : 'A';
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      if (throttled) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 4_000_000 / 8, uploadThroughput: 3_000_000 / 8 });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      const home = page.getByTestId('new-conversation-input');
      await home.fill('性能输入验证');
      assert.equal(await home.innerText(), '性能输入验证');
      const startup = await page.evaluate(() => performance.now());
      const homeText = await page.locator('body').innerText();
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => {
        const resource = entry as PerformanceResourceTiming;
        return { name: new URL(resource.name).pathname, bytes: resource.encodedBodySize, end: resource.responseEnd };
      }));
      await home.fill('');
      if (run === 0) {
        // CSS backgrounds load independently of editor readiness. Await their
        // decode for visual parity, outside the measured readiness interval.
        await page.evaluate(async () => {
          await Promise.all([...document.querySelectorAll('.brand-mark, .new-chat-mark')].map(async element => {
            const url = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(element).backgroundImage)?.[1];
            if (url) { const image = new Image(); image.src = url; await image.decode(); }
          }));
        });
        for (const width of [768, 1440]) {
          await page.setViewportSize({ width, height: 960 });
          await page.screenshot({ path: join(root, `${label}-home-${width}.png`), animations: 'disabled' });
        }
      }
      const chatStart = await page.evaluate(() => performance.now());
      await page.locator(`a[href="#/conversations/${server.perfConversation}"]`).first().click();
      await page.getByText('保存的性能验证消息', { exact: true }).waitFor();
      const chat = page.locator('[contenteditable="true"]').first();
      await chat.fill('会话输入验证');
      assert.equal(await chat.innerText(), '会话输入验证');
      const conversation = await page.evaluate(() => performance.now()) - chatStart;
      const graphStart = await page.evaluate(() => performance.now());
      // Navigate through the app's public hash router, just as a graph link does.
      await page.evaluate(id => { location.hash = `#/tasks/${id}/graph`; }, server.perfGraph);
      await page.locator('.react-flow__node').nth(1).waitFor({ state: 'visible' });
      await page.locator('.react-flow__edge').first().waitFor({ state: 'visible' });
      await page.locator('.react-flow__node').first().click();
      const graph = await page.evaluate(() => performance.now()) - graphStart;
      const graphText = await page.locator('[data-testid="graph"]').innerText();
      if (run === 0) {
        for (const width of [768, 1440]) {
          await page.setViewportSize({ width, height: 960 });
          await page.screenshot({ path: join(root, `${label}-graph-${width}.png`), animations: 'disabled' });
        }
      }
      assert.deepEqual(errors, []);
      results[label]!.push({ startup, conversation, graph, homeText, graphText, resources });
      await context.close();
      console.log(`${run + 1}/${runs} ${label}: startup=${startup.toFixed(0)} chat=${conversation.toFixed(0)} graph=${graph.toFixed(0)}`);
    }
  }
  await writeFile(`${output}.raw.json`, JSON.stringify({ root, results }, null, 2));
  // The public asset transport must preserve every byte and honor opt-out.
  const files = (await readdir(join(candidate, 'assets'))).filter(file => /\.(js|css|json)$/.test(file));
  for (const file of files) {
    const address = `${servers[1]!.url}/assets/${file}?transport=guard`;
    const original = await readFile(join(candidate, 'assets', file));
    for (const encoding of ['gzip', 'identity', 'gzip;q=0, *;q=1', '*', 'br, gzip;q=0.5']) {
      const response = await fetch(address, { headers: { 'accept-encoding': encoding } });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), original, `${file} ${encoding}`);
      assert.equal(response.headers.get('vary'), 'Accept-Encoding');
      if (encoding === 'identity' || encoding.startsWith('gzip;q=0')) assert.equal(response.headers.get('content-encoding'), null);
    }
  }
  for (const key of ['homeText', 'graphText']) {
    assert.equal((results.A![0] as Record<string, unknown>)[key], (results.B![0] as Record<string, unknown>)[key], `visible golden: ${key}`);
  }
  const percentile = (numbers: number[], p: number) => numbers.sort((a, b) => a - b)[Math.ceil(numbers.length * p) - 1];
  const summary = Object.fromEntries(Object.entries(results).map(([label, rows]) => [label, Object.fromEntries(['startup', 'conversation', 'graph'].map(metric => [metric,
    Object.fromEntries([50, 75, 95].map(p => [`p${p}`, percentile(rows.map(row => (row as Record<string, number>)[metric]!), p / 100)]))]))]));
  await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), root, baseline, candidate, runs, profile: throttled ? 'Fast4G 20ms 4/3Mbps' : 'local loopback, unthrottled', summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  for (const server of servers.reverse()) await server.close();
}
