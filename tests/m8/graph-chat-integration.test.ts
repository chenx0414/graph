import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/**
 * A chat queue item declares no required outputs, so a node can submit during a chat turn — but a chat
 * execution used to skip settleWorkspace entirely, so that commit was never merged and the work vanished
 * with no record. Two worker rounds were lost this way on a live graph before the worker read the guard.
 * A chat is still not a delivery: the deliverable stays unsettled, and a chat turn that merely edits the
 * working tree must not push that draft into the integration (tests/m8/kernel-git-integration.test.ts).
 * Only a chat execution that really submitted has its commit integrated.
 */
test('a chat-driven execution that submits has its work integrated instead of losing it silently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-chat-integration-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'feature.txt'), 'before\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  const original = git(project, ['rev-parse', 'HEAD']).stdout.trim();
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const provider = await openaiServer([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'implemented\n' }) }] },
    { tools: [{ id: 'commit', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['feature.txt'], message: 'chat implementation' }) }] },
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { summary: 'implemented' } } } }) }] },
    { text: 'implementation submitted' },
  ]);
  cleanup.push(() => provider.close());
  const stateDir = join(root, 'state');
  const runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    limits: { defaultBudgetTokens: 20000000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-fixture', modelRuntime: provider.runtime },
  });
  cleanup.push(() => runtime.close());
  await runtime.catalog.saveAgentCombination({ id: 'native', name: 'Native', description: 'worker', recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'Implement the assigned file.' });
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const parent = await runtime.user.begin({ projectId: 'p', request: 'chat integration', requestId: 'parent' });
  const main = runtime.supervisor(parent.taskId);
  const graph = await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'chat work',
    protocols: { data: { type: 'object' } }, nodes: { work: { recipe: 'native@1', task: 'implement feature.txt', inputs: { start: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
    modules: {}, edges: {}, outputs: { result: { from: 'work.result', protocol: 'data' } } }) }) as { graphId: string };
  // A chat turn, not a delivery: this is what main's own message to a node produces.
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', text: 'implement feature.txt' });
  await runtime.host.drive();
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close());
  const integration = disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graph.graphId}`) as { path: string };
  expect(await readFile(join(integration.path, 'feature.txt'), 'utf8')).toBe('implemented\n');
  expect(disk.task(graph.graphId).integration_sha).not.toBe(original);
}, 30000);
