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
  // The tooltip says what the number is made of, so nobody has to guess.
  const title = await tps.getAttribute('title');
  expect(title).toContain('240 tokens');
  expect(title).toMatch(/用时 \d+\.\d 秒/);
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
  await page.screenshot({ path: join(evidenceDir(root, 'console-tps'), 'node.png'), fullPage: false });
}, 240_000);
