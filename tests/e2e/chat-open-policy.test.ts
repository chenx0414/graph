import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import type { Browser } from 'playwright';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { launchBrowser } from '../helpers/host-browser.ts';
import { run } from './go-graph-confirmation.fixture.ts';

/**
 * One transcript policy for every chat window: the answer stands alone, and the
 * thinking above it folds into one line.
 *
 * Measured 2026-11-04, twice, in opposite directions: first a settled node run
 * could keep its last turn in live dress (loose rows that never folded into the
 * turn above), then the live work itself was opened on the theory that the
 * reader wants to watch it — which made a running turn a wall of tool rows with
 * the answer pushed below it, and made the same conversation look different at
 * the two ends of a run. The policy that survived is the one this test pins: a
 * turn block folds once its answer lands (measured 2026-11-05: open-by-default
 * left a wall of narration above every answer), stays open while the turn is in
 * flight, and every tool group starts folded — one click opens the detail.
 *
 * This drives the real node chat against a real daemon with one settled turn and
 * one in-flight turn and measures the rendered DOM, not the attributes alone: a
 * group that claims to be folded must reserve no height for its detail, and the
 * click that opens it must produce height.
 */
test('every chat window folds the tool work inside an open turn, live and settled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-open-policy-'));
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let browser: Browser | undefined;
  try {
    const project = join(root, 'project');
    await mkdir(project);
    await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(root, 'web'), emptyOutDir: true } });
    await writeFile(join(project, 'README.md'), '# project\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
      await run('git', args, { cwd: project });
    }
    const config = join(root, 'graph.config.json');
    await writeFile(config, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_OPEN_POLICY_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', grade: 'high', api: 'openai-completions', maxTokens: 256, credentialId: 'local', contextWindow: 32000, baseUrl: 'http://127.0.0.1:9/v1' }] },
    }));
    daemon = await launchCli(root, { configPath: config, extraArgs: ['--execute'], env: { GRAPH_OPEN_POLICY_KEY: 'synthetic-key' } });

    const thread = await daemon.request('/api/projects/p/thread', { method: 'POST', body: JSON.stringify({ requestId: 'thread' }) });
    expect(thread.status).toBe(200);
    const conversationId = (await thread.json()).conversationId as string;
    const conversation = await daemon.request(`/api/conversations/${conversationId}`, {});
    const taskId = (await conversation.json()).anchorTaskId as string;
    expect(taskId).toBeTruthy();

    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
    const insert = db.prepare('INSERT INTO node_entries(id,task_id,node_id,operation_id,role,kind,text,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    // A settled turn: a request, the tool work it did, and its answer.
    insert.run('settled-1', taskId, 'master', 'op-settled', 'user', 'chat', '先把仓库跑起来', null, 1);
    insert.run('settled-2', taskId, 'master', 'op-settled', 'tool', 'tool', 'bash: npm test', JSON.stringify({ toolCallId: 'call-settled' }), 2);
    insert.run('settled-3', taskId, 'master', 'op-settled', 'assistant', 'chat', '测试跑完了，全部通过', null, 3);
    // A turn still in flight: its work has to be visible while it happens.
    insert.run('live-1', taskId, 'master', 'op-live', 'user', 'chat', '再跑一次带覆盖率的', null, 4);
    insert.run('live-2', taskId, 'master', 'op-live', 'tool', 'tool', 'bash: npm run coverage', JSON.stringify({ toolCallId: 'call-live' }), 5);
    db.exec('COMMIT');
    db.close();

    browser = (await launchBrowser()).browser;
    const page = await browser.newPage();
    await page.goto(`${daemon.url}/#/tasks/${taskId}/nodes/master`);
    await expect.poll(() => page.getByTestId('node-chat-input').isVisible(), { timeout: 30_000 }).toBe(true);

    // The settled turn is one block, and the answer arriving folded it.
    await expect.poll(() => page.locator('[data-testid="collapsed-turn"]').count(), { timeout: 60_000 }).toBe(1);
    const turn = page.locator('[data-testid="collapsed-turn"]').first();
    await expect.poll(() => turn.getAttribute('data-open')).toBe('false');
    // Folded is not empty and not a hiding place for the answer: the answer is a
    // row of its own below the block, and the block reserves no height for detail.
    expect(await page.getByText('测试跑完了，全部通过').count()).toBeGreaterThan(0);
    expect(await turn.locator('.collapsed-turn-body').count()).toBe(0);
    // One click brings the turn's work back, still with its groups folded.
    await turn.locator('.collapsed-turn-toggle').click();
    await expect.poll(() => turn.getAttribute('data-open')).toBe('true');
    await expect.poll(async () => turn.locator('.collapsed-turn-body').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(0);

    // Tool groups start folded everywhere, and a folded group reserves no height
    // for its detail: the settled one now visible inside the turn, and the
    // in-flight one, which is loose because its turn has no answer yet.
    const groups = page.locator('[data-testid="tool-activity-group"]');
    await expect.poll(() => groups.count(), { timeout: 30_000 }).toBe(2);
    for (let index = 0; index < 2; index += 1) {
      const group = groups.nth(index);
      // Offscreen history rows are laid out lazily, so a row is scrolled in before
      // its geometry is read: 0px must mean folded, never "never laid out".
      await group.scrollIntoViewIfNeeded();
      expect(await group.getAttribute('data-open')).toBe('false');
      const closed = await group.locator('.tool-group-content').evaluate(node => node.getBoundingClientRect().height);
      expect(closed).toBe(0);
      // Folded is not empty: the rows are there, behind the toggle.
      expect(await group.locator('.tool-activity-list li').count()).toBeGreaterThan(0);
    }

    // Folded is the default, not a permanent state: one click opens the group and
    // produces height, a second click folds it back. The in-flight group is opened
    // too, so a running turn's work is exactly one click away, like settled work.
    for (let index = 0; index < 2; index += 1) {
      const group = groups.nth(index);
      await group.locator('.tool-group-toggle').click();
      await expect.poll(() => group.getAttribute('data-open')).toBe('true');
      // The attribute flips at once but the body animates open, so the height is
      // polled to its settled value instead of read on the frame after the click.
      await expect.poll(async () => group.locator('.tool-group-content').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(0);
      await group.locator('.tool-group-toggle').click();
      await expect.poll(() => group.getAttribute('data-open')).toBe('false');
      await expect.poll(() => group.locator('.tool-group-content').evaluate(node => node.getBoundingClientRect().height)).toBe(0);
    }

    // The settled turn's work belongs to the turn block; the in-flight turn keeps
    // its rows loose until its answer arrives, which is why only one of the two
    // groups is inside the block.
    expect(await turn.locator('[data-testid="tool-activity-group"]').count()).toBe(1);
  } finally {
    await browser?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 240_000);
