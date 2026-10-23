import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'vite';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The branch a graph is confirmed on.
 *
 * When a user confirms a draft, the branch matters: the graph has to work on
 * a branch that really exists, and the user must be able to choose a
 * different one than the one the project happens to sit on. The console shows
 * what the project really is - the branch it is on, or the branch it was
 * prepared on - and the choice the user types is the one the confirmation
 * carries.
 *
 * The proof is a real repository with real branches, a real daemon and the
 * real console: the field starts on the branch the evidence names, the
 * user's own branch survives the confirmation, and the repository is left
 * where it was.
 */

const execute = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

/** Real git, in a real repository. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, { cwd });
  return stdout.trim();
}

const PROPOSAL = {
  requirementVersion: 1,
  summary: '修复登录问题',
  acceptance: [{ id: 'human', description: 'Human confirms selected branch', checkNode: 'work' }],
  definition: {
    schemaVersion: 2, name: '修复登录问题', protocols: {},
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Review branch selection', inputs: {}, outputs: {}, submission: {} } },
    modules: {}, edges: {},
    acceptance: [{ id: 'human', description: 'Human confirms selected branch', kind: 'human' }],
  },
};

test.each(['current', 'prepared-detached', 'unknown-detached'] as const)('the browser confirmation uses real %s project branch evidence and preserves user edits', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-project-branch-ui-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'README.md'), 'branch selection\n');
  await git(project, ['init', '-q', '-b', 'feature/current']);
  await git(project, ['add', '.']);
  await git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  await git(project, ['branch', 'release/manual']);
  await git(project, ['branch', 'main']);
  const webDir = join(root, 'web');
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });

  const provider = await openaiServer([
    { tools: [{ id: 'draft', name: 'propose_graph', arguments: JSON.stringify({ proposal: PROPOSAL, requestId: 'draft' }) }] },
    { text: 'Draft ready for confirmation' },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, GRAPH_LOCAL_KEY: 'synthetic-only' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());

  // The project is prepared by hand, the way the console's own button does it.
  if (mode === 'prepared-detached') {
    const prepared = await daemon.request('/api/projects/p/prepare', {
      method: 'POST', body: JSON.stringify({ requestId: 'branch-prepare', initialize: true, createBaseline: true }),
    });
    expect(prepared.status).toBe(200);
  }
  if (mode !== 'current') await git(project, ['checkout', '--detach', '-q']);

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
  const answer = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/confirm'));
  await page.getByTestId('confirm-draft').click();
  expect((await confirmation).postDataJSON()).toMatchObject({ targetBranch: 'release/manual' });

  // The confirmed graph really works on the branch the user chose.
  const confirmed = await answer;
  expect(confirmed.status()).toBe(200);
  const taskId = (await confirmed.json() as { taskId: string }).taskId;
  expect(taskId).not.toBe('');
  await expect.poll(async () => {
    const view = await (await daemon.request(`/api/tasks/${taskId}`)).json() as { targetBranch: string };
    return view.targetBranch;
  }).toBe('release/manual');
  expect(await git(project, ['branch', '--show-current'])).toBe(mode === 'current' ? 'feature/current' : '');
}, 180_000);
