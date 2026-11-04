import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import { chromium, type Browser } from 'playwright';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { run } from './go-graph-confirmation.fixture.ts';

/**
 * One transcript policy for every chat window: what the reader must see is open.
 *
 * Measured 2026-11-04 in the console: a running turn rendered its tool groups
 * folded (the reader watched a summary instead of the work), and a settled node
 * run could keep its last turn in live dress — loose rows that never folded into
 * the turn above. This drives the real node chat against a real daemon with one
 * settled turn and one in-flight turn and measures the rendered DOM, not the
 * attributes alone: a group that claims to be open must have a body with height.
 */
test('every chat window opens the tool work it renders, live and settled', async () => {
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

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${daemon.url}/#/tasks/${taskId}/nodes/master`);
    await expect.poll(() => page.getByTestId('node-chat-input').isVisible(), { timeout: 30_000 }).toBe(true);

    // The settled turn is one block, and the block is open.
    await expect.poll(() => page.locator('[data-testid="collapsed-turn"]').count(), { timeout: 60_000 }).toBe(1);
    const turn = page.locator('[data-testid="collapsed-turn"]').first();
    expect(await turn.getAttribute('data-open')).toBe('true');

    // Both tool groups render open, and each one has a body with real height.
    const groups = page.locator('[data-testid="tool-activity-group"]');
    await expect.poll(() => groups.count(), { timeout: 30_000 }).toBe(2);
    for (let index = 0; index < 2; index += 1) {
      const group = groups.nth(index);
      expect(await group.getAttribute('data-open')).toBe('true');
      const height = await group.locator('.tool-group-content').evaluate(node => node.getBoundingClientRect().height);
      expect(height).toBeGreaterThan(0);
    }

    // The settled turn's work belongs to the turn block; the in-flight turn keeps
    // its rows loose until its answer arrives.
    expect(await turn.locator('[data-testid="tool-activity-group"]').count()).toBe(1);
  } finally {
    await browser?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 240_000);
