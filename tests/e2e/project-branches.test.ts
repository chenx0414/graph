import { build } from 'vite';
import { chromium } from 'playwright';
import { startGraphDaemon } from '../../src/server/start.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git } from '../fixtures/native-worktree-graph.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('real graph and native worker Git branches use readable safe unique names without overwriting occupied paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-branches-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'README.md'), 'branch naming fixture\n');
  git(project, ['init', '-q', '-b', 'feature/current']);
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  const provider = await openaiServer([{ text: 'worker naming observed' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'synthetic-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: 'graph-openai', grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Name native workspaces', requestId: 'begin' });
  const main = runtime.supervisor(owner.taskId);
  const disk = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(() => disk.close());
  const cases = [
    ['修复登录问题', 'xiu-fu-deng-lu-wen-ti'], ['新增导出功能', 'xin-zeng-dao-chu-gong-neng'],
    ['看板四态可视化', 'kan-ban-si-tai-ke-shi-hua'], ['Fix 修复 login 问题', 'fix-xiu-fu-login-wen-ti'],
    ['v2 重构 API', 'v2-zhong-gou-api'], ['修复  登录!!! 问题', 'xiu-fu-deng-lu-wen-ti'],
    ['龘龘', '龘-龘'], ['!!! ??? ...', 'task'], ['修复'.repeat(40), 'xiu-fu-xiu-fu-xiu-fu-xiu-fu-xiu-fu-xiu-f'],
    ['修复登录问题', 'xiu-fu-deng-lu-wen-ti'],
  ] as const;
  const branches: string[] = [];
  let firstGraph = '';
  for (const [index, [name, slug]] of cases.entries()) {
    const created = await main.graphCreate({ targetBranch: 'feature/current', requestId: `graph-${index}`, definition: { schemaVersion: 2, name, protocols: {}, nodes: { worker: { recipe: 'worker@1', model: 'local', task: 'Observe branch naming', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {}, inputs: {}, outputs: {} } }) as { graphId: string };
    const shortId = created.graphId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8);
    const expected = `graph/task/${slug}-${shortId}`;
    const row = disk.task(created.graphId);
    expect(row.integration_branch).toBe(expected);
    expect(git(project, ['check-ref-format', '--branch', expected])).toBe(expected);
    const tree = disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${created.graphId}`) as { path: string };
    expect(basename(dirname(tree.path))).toBe(`${slug}-${shortId}`);
    expect(git(tree.path, ['branch', '--show-current'])).toBe(expected);
    expect(slug.length).toBeLessThanOrEqual(40);
    branches.push(expected);
    if (index === 0) firstGraph = created.graphId;
  }
  expect(new Set(branches).size).toBe(cases.length);
  const integration = disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${firstGraph}`) as { path: string };
  const occupied = join(dirname(integration.path), 'worker');
  await mkdir(occupied);
  await writeFile(join(occupied, 'retained.txt'), 'do not overwrite');
  for (const suffix of [2, 3]) await mkdir(join(dirname(integration.path), `worker-${suffix}`));
  await main.graphSend({ graphId: firstGraph, nodeId: 'worker', text: 'Observe my real workcopy branch' });
  await runtime.host.drive();
  const worker = disk.db.prepare('SELECT path,branch FROM worktrees WHERE task_id=? AND node_id=?').get(firstGraph, 'worker') as { path: string; branch: string };
  expect(basename(worker.path)).toBe('worker-4');
  expect(worker.branch).toBe(`graph/copy/xiu-fu-deng-lu-wen-ti-${firstGraph.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}/worker`);
  expect(git(worker.path, ['branch', '--show-current'])).toBe(worker.branch);
  expect(await readFile(join(occupied, 'retained.txt'), 'utf8')).toBe('do not overwrite');
  expect(provider.requests.length).toBeGreaterThan(0);
  expect(git(project, ['branch', '--show-current'])).toBe('feature/current');
}, 90_000);

test.each(['current', 'prepared-detached', 'unknown-detached'] as const)('the browser confirmation uses real %s project branch evidence and preserves user edits', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-project-branch-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'README.md'), 'branch selection\n');
  git(project, ['init', '-q', '-b', 'feature/current']);
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  git(project, ['branch', 'release/manual']);
  git(project, ['branch', 'main']);
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
  const proposal = { requirementVersion: 1, summary: '修复登录问题', acceptance: [{ id: 'human', description: 'Human confirms selected branch', checkNode: 'work' }], definition: { schemaVersion: 2, name: '修复登录问题', protocols: {}, nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Review branch selection', inputs: {}, outputs: {}, submission: {} } }, modules: {}, edges: {}, acceptance: [{ id: 'human', description: 'Human confirms selected branch', kind: 'human' }] } };
  const provider = await openaiServer([{ tools: [{ id: 'draft', name: 'propose_graph', arguments: JSON.stringify({ proposal, requestId: 'draft' }) }] }, { text: 'Draft ready for confirmation' }]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: 'synthetic-only' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  if (mode === 'prepared-detached') await daemon.server.runtime.projects.prepare({ projectId: 'p', requestId: 'branch-prepare', createBaseline: true });
  if (mode !== 'current') git(project, ['checkout', '--detach', '-q']);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(daemon.url);
  const settings = await (await page.request.get(`${daemon.url}/api/settings`)).json();
  const observed = settings.projects.find((project: { id: string }) => project.id === 'p');
  expect(observed.branch).toBe(mode === 'current' ? 'feature/current' : null);
  if (mode === 'prepared-detached') expect(observed.preparation).toMatchObject({ branch: 'feature/current' });
  if (mode === 'unknown-detached') expect(observed.preparation).toBeNull();
  const createdResponse = await page.request.post(`${daemon.url}/api/conversations`, { headers: { origin: daemon.url }, data: { projectId: 'p', text: 'Propose the branch selection task', requestId: 'branch-ui' } });
  expect(createdResponse.ok()).toBe(true);
  const created = await createdResponse.json() as { conversationId: string };
  await page.goto(`${daemon.url}/#/conversations/${created.conversationId}`);
  await expect.poll(() => page.getByTestId('drawer-entry-label').innerText(), { timeout: 30_000 }).toContain('草稿 v1');
  await page.getByTestId('drawer-entry').click();
  await page.getByTestId('accept-branch').waitFor({ timeout: 30_000 });
  await expect.poll(() => page.getByTestId('accept-branch').inputValue()).toBe(mode === 'unknown-detached' ? 'main' : 'feature/current');
  await page.getByTestId('accept-branch').fill('release/manual');
  const confirmation = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/confirm'));
  await page.getByTestId('confirm-draft').click();
  expect((await confirmation).postDataJSON()).toMatchObject({ targetBranch: 'release/manual' });
  const disk = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(() => disk.close());
  await expect.poll(() => (disk.db.prepare('SELECT target_branch FROM tasks WHERE conversation_id=? AND graph_version IS NOT NULL').all(created.conversationId) as { target_branch: string }[]).map(row => row.target_branch)).toContain('release/manual');
  expect(git(project, ['branch', '--show-current'])).toBe(mode === 'current' ? 'feature/current' : '');
}, 120_000);
