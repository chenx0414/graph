import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { launchBrowser, type LaunchedBrowser } from '../helpers/host-browser.ts';
import { run } from './go-graph-confirmation.fixture.ts';

/**
 * A subagent's chat opens its whole history.
 *
 * Measured 2026-11-04: the node chat loaded one page and left the rest behind a
 * "载入更早记录" button, so a reader who asked for earlier records to be open
 * still had to click for them. This drives the real console against a real
 * daemon and seeds a run longer than one page (450 entries against a 200-entry
 * first page) and asserts the oldest record arrives without any click.
 */
test('a subagent chat opens the whole run without a load-older click', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-history-'));
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let launched: LaunchedBrowser | undefined;
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
      credentials: { local: { secretRef: 'GRAPH_HISTORY_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', grade: 'high', api: 'openai-completions', maxTokens: 256, credentialId: 'local', contextWindow: 32000, baseUrl: 'http://127.0.0.1:9/v1' }] },
    }));
    daemon = await launchCli(root, { configPath: config, extraArgs: ['--execute'], env: { GRAPH_HISTORY_KEY: 'synthetic-key' } });

    const thread = await daemon.request('/api/projects/p/thread', { method: 'POST', body: JSON.stringify({ requestId: 'thread' }) });
    expect(thread.status).toBe(200);
    const conversationId = (await thread.json()).conversationId as string;
    const conversation = await daemon.request(`/api/conversations/${conversationId}`, {});
    const taskId = (await conversation.json()).anchorTaskId as string;
    expect(taskId).toBeTruthy();

    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
    const insert = db.prepare('INSERT INTO node_entries(id,task_id,node_id,role,kind,text,data,created_at) VALUES(?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let index = 1; index <= 450; index += 1) {
      const oldest = index === 1;
      insert.run(`seed-${index}`, taskId, 'master', index % 2 === 1 ? 'assistant' : 'user', 'chat', oldest ? '最早的一条记录' : `历史记录 ${index}`, null, index);
    }
    db.exec('COMMIT');
    db.close();

    // The launcher, not this test, decides how a browser may start here: inside
    // Graph's command sandbox every Chromium build segfaults on launch, so the
    // helper starts it in the host session and drives it over CDP.
    launched = await launchBrowser();
    const page = await launched.browser.newPage();
    await page.goto(`${daemon.url}/#/tasks/${taskId}/nodes/master`);
    await expect.poll(() => page.getByTestId('node-chat-input').isVisible(), { timeout: 30_000 }).toBe(true);
    // No click: the oldest record has to arrive on its own.
    await expect.poll(() => page.getByText('最早的一条记录').count(), { timeout: 60_000 }).toBeGreaterThan(0);
    expect(await page.getByTestId('node-load-older').count()).toBe(0);
  } finally {
    await launched?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 240_000);
