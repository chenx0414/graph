import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { PROPOSAL } from './go-graph-confirmation.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object');
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, key: string): string {
  const item = object(value)[key];
  if (typeof item !== 'string' || !item) throw new Error(`Expected ${key}`);
  return item;
}

test('a user reviews independent work drafts and confirms a graph in the browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-work-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }] }));
  const daemon = await launchCli(root, { configPath, webDir });
  cleanup.push(() => daemon.close());
  async function post(path: string, body: object) {
    const response = await daemon.request(path, { method: 'POST', body: JSON.stringify(body) });
    const value: unknown = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value;
  }
  const global = text(await post('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
  await post('/api/projects/p/thread', { requestId: 'project' });
  async function createDraft(label: string) {
    const message = text(await post(`/api/conversations/${global}/messages`, { requestId: `message-${label}`, text: `Plan ${label}` }), 'messageId');
    const work = text(await post('/api/orchestration/work', {
      requestId: `work-${label}`, conversationId: global, projectId: 'p', sourceMessageId: message,
      brief: `Build ${label}`, acceptance: [`${label} works`],
    }), 'id');
    await post(`/api/orchestration/work/${work}/drafts`, {
      requestId: `draft-${label}`, workRevision: 1, proposal: { ...PROPOSAL, summary: `Plan ${label}` },
    });
    return work;
  }
  const first = await createDraft('first');
  const second = await createDraft('second');
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/conversations/${global}`);
  const firstCard = page.getByTestId(`work-draft-${first}-1`);
  const secondCard = page.getByTestId(`work-draft-${second}-1`);
  await expect.poll(() => firstCard.count(), { timeout: 30_000 }).toBe(1);
  expect(await firstCard.innerText()).toContain('Plan first');
  expect(await secondCard.innerText()).toContain('Plan second');
  await firstCard.getByText('查看任务图定义').click();
  expect(await firstCard.locator('pre').innerText()).toContain('schemaVersion');
  await firstCard.getByRole('button', { name: '确认草稿' }).click();
  await expect.poll(() => firstCard.getByRole('button', { name: '已确认' }).count(), { timeout: 30_000 }).toBe(1);
  expect(await firstCard.getByRole('link', { name: '查看任务图' }).count()).toBe(1);
  expect(await secondCard.getByRole('button', { name: '确认草稿' }).isEnabled()).toBe(true);
  await page.reload();
  await expect.poll(() => firstCard.getByRole('button', { name: '已确认' }).count(), { timeout: 30_000 }).toBe(1);
  expect(await secondCard.getByRole('button', { name: '确认草稿' }).isEnabled()).toBe(true);
}, 120_000);
