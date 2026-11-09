import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page } from 'playwright';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { evidenceDir } from '../helpers/evidence.ts';
import { launchBrowser } from '../helpers/host-browser.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// The composer footer already prints the cache hit rate. The user asked for the
// cache's expiry as well, and no provider in use reports an expiry instant: the
// xAI docs say cache entries "can be evicted at any time due to server load or
// restarts", DeepSeek reports hit and miss tokens only, and Anthropic's TTL is
// the one the caller sent, not something the response tells us. So the footer
// prints what is measurable instead - the cached prefix the last turn really
// read, and how long ago that request ran - and says so in its tooltip rather
// than inventing a deadline.
//
// The proof is a real daemon on real loopback with a controlled provider, read
// back out of the DOM at two ages: the age the turn really has, and an age the
// settled ledger really records (the ledger row is backdated, the view is not
// faked, so the formatting path is exercised end to end).

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

interface ConversationView {
  messages: { role: string; text?: string }[];
  telemetry: {
    cacheHitRate: number | null;
    cacheHitRateTotal: number | null;
    cachedInput: number;
    cacheInput: number;
    cacheReadTokens: number | null;
    cacheUsedAt: number | null;
  };
}

interface Daemon {
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

async function conversationView(daemon: Daemon, id: string): Promise<ConversationView> {
  return await (await daemon.request(`/api/conversations/${id}`)).json() as ConversationView;
}

async function waitForAnswer(daemon: Daemon, id: string, text: string) {
  await expect.poll(async () => (await conversationView(daemon, id)).messages.some(message => (message.text ?? '').includes(text)),
    { timeout: 30_000, interval: 100 }).toBe(true);
}

function cacheText(page: Page) {
  return page.getByTestId('telemetry-cache');
}

/** Held open by the provider until the test has read the ledger mid-turn. */
let release: () => void = () => undefined;
const released = new Promise<void>(resolve => { release = () => resolve(); });

test('the composer footer reports the cached prefix and how long ago it was read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-console-cache-age-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  // Two real turns through a controlled provider: the first pays for the whole
  // prompt, the second is served 900 of its 1100 input tokens from the cache.
  const provider = await openaiServer([
    { text: 'First answer.', usage: { prompt_tokens: 1_000, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 0 } } },
    // prompt_tokens includes the cached tokens, the way every provider bills it.
    { text: 'Second answer.', usage: { prompt_tokens: 1_100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 900 } } },
    // The third turn calls a tool and then waits: its first provider call is already
    // in the ledger while the operation is still open, which is the state a real turn
    // spends most of its time in.
    { tools: [{ id: 'tool-1', name: 'bash', arguments: JSON.stringify({ command: 'true' }) }], usage: { prompt_tokens: 300, completion_tokens: 5 } },
    { text: 'Third answer.', beforeReply: () => released, usage: { prompt_tokens: 320, completion_tokens: 8 } },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_CACHE_AGE_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, webDir, extraArgs: ['--execute'], env: { GRAPH_CACHE_AGE_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', title: 'Cache age', text: 'First question.', requestId: 'cache-first' }),
  });
  const createdText = await created.text();
  expect(created.status, createdText).toBe(200);
  const conversationId = (JSON.parse(createdText) as { conversationId: string }).conversationId;
  await waitForAnswer(daemon, conversationId, 'First answer.');

  const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'Second question.', requestId: 'cache-second' }),
  });
  expect(second.status, await second.text()).toBe(200);
  await waitForAnswer(daemon, conversationId, 'Second answer.');
  expect(provider.requests).toHaveLength(2);

  // The daemon's own view carries the two new numbers: what the newest turn read
  // from the cache, and when that request settled.
  const view = await conversationView(daemon, conversationId);
  expect(view.telemetry.cacheReadTokens).toBe(900);
  // The rate and the token count describe the same request: 900 cached of that
  // request's 1_100 input tokens. The session-wide rate is a separate number.
  expect(view.telemetry.cacheHitRate).toBeCloseTo(900 / 1_100, 6);
  expect(view.telemetry.cacheHitRateTotal).toBeCloseTo(900 / 2_100, 6);
  expect(view.telemetry.cacheUsedAt).not.toBeNull();
  const settledAt = view.telemetry.cacheUsedAt as number;
  expect(Math.abs(Date.now() - settledAt)).toBeLessThan(5 * 60_000);
  const { browser } = await launchBrowser();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  await page.goto(`${daemon.url}/#/conversations/${conversationId}`);
  await page.getByTestId('conversation').waitFor();
  const cache = cacheText(page);
  await cache.waitFor();
  // The footer reads 82% (900 of that request's 1_100 input tokens), the 900
  // tokens the last request really read, and how fresh that is.
  await expect.poll(async () => await cache.innerText(), { timeout: 15_000 }).toMatch(/^CH 82% · 刚刚$/);
  expect(Number(await cache.getAttribute('data-cache-used-at'))).toBe(settledAt);
  // The tooltip says where the number comes from, and that no provider reports
  // an expiry instant - the word "过期" is not claimed as a known deadline.
  const title = await cache.getAttribute('title');
  expect(title).toContain('命中缓存');
  expect(title).toContain('不报告缓存过期时刻');
  await page.screenshot({ path: join(evidenceDir(root, 'composer-cache-age'), 'fresh.png'), fullPage: false });

  // The same page, one backdated ledger row later: the age is the record's, the
  // clock is the reader's, and the footer says four minutes because the request
  // really settled four minutes ago.
  execFileSync('sqlite3', [join(root, 'state', 'tasks.sqlite'),
    'UPDATE operations SET settled_at = settled_at - 240000 WHERE settled_at IS NOT NULL;']);
  await expect.poll(async () => {
    const reloaded = await conversationView(daemon, conversationId);
    return reloaded.telemetry.cacheUsedAt;
  }, { timeout: 10_000 }).toBe(settledAt - 240_000);
  await page.reload();
  await page.getByTestId('conversation').waitFor();
  await expect.poll(async () => await cacheText(page).innerText(), { timeout: 15_000 }).toMatch(/^CH 82% · 4 分钟前$/);
  await page.screenshot({ path: join(evidenceDir(root, 'composer-cache-age'), 'aged.png'), fullPage: false });

  // A turn that is still running records its own provider call before its operation
  // settles. The footer keeps the last finished request then - tokens and age
  // together - instead of blanking the age in the middle of every turn. The third
  // turn is held at its second provider call, so the open operation is a fact here,
  // not a race.
  const third = await daemon.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'Third question.', requestId: 'cache-third' }),
  });
  expect(third.status, await third.text()).toBe(200);
  await expect.poll(() => provider.requests.length, { timeout: 20_000 }).toBe(4);
  const midTurn = await conversationView(daemon, conversationId);
  expect(midTurn.telemetry.cacheUsedAt).toBe(settledAt - 240_000);
  expect(midTurn.telemetry.cacheReadTokens).toBe(900);
  release();
  await waitForAnswer(daemon, conversationId, 'Third answer.');
});
