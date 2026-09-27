import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

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
  // A node opens as its own chat tab now: the injected system prompt sits above the transcript.
  await page.locator('.react-flow__node').filter({ hasText: 'work' }).first().click();
  const section = page.getByTestId('node-prompt');
  await section.waitFor();
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
