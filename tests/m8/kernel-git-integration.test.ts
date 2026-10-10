import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('native worker output is integrated from its own worktree and leaves the target branch pending delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-git-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'feature.txt'), 'before\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  const original = git(project, ['rev-parse', 'HEAD']).stdout.trim();
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const provider = await openaiServer([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'implemented\n' }) }] },
    { tools: [{ id: 'premature', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'deliverables', name: 'code', sourcePath: 'feature.txt', metadata: { kind: 'code' }, requestId: 'premature' }) }] },
    { tools: [{ id: 'outside', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['../outside.txt'], message: 'must be refused' }) }] },
    { tools: [{ id: 'commit', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['feature.txt'], message: 'stable implementation' }) }] },
    { tools: [{ id: 'publish', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'deliverables', name: 'code', sourcePath: 'feature.txt', metadata: { kind: 'code' }, requestId: 'code' }) }] },
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { summary: 'implemented' } } } }) }] },
    { text: 'implementation submitted' },
    { tools: [{ id: 'later-write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'later working version\n' }) }] },
    { text: 'working file changed' },
    { tools: [{ id: 'later-submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { summary: 'integrate later version' } } } }) }] },
    { text: 'later version ready to integrate' },
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
  const parent = await runtime.user.begin({ projectId: 'p', request: 'native Git integration', requestId: 'parent' });
  const main = runtime.supervisor(parent.taskId);
  const graph = await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'native work',
    protocols: { data: { type: 'object' } }, nodes: { work: { recipe: 'native@1', task: 'implement feature.txt', inputs: { start: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
    modules: {}, edges: {}, outputs: { result: { from: 'work.result', protocol: 'data' } } }) }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'start', value: {} });
  await runtime.host.drive();
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close());
  const worker = disk.db.prepare('SELECT path FROM worktrees WHERE task_id=? AND node_id=?').get(graph.graphId, 'work') as { path: string };
  expect(await readFile(join(worker.path, 'feature.txt'), 'utf8')).toBe('implemented\n');
  const integration = disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graph.graphId}`) as { path: string };
  expect(await readFile(join(integration.path, 'feature.txt'), 'utf8')).toBe('implemented\n');
  expect(disk.task(graph.graphId).integration_sha).not.toBe(original);
  const published = runtime.artifacts.list(graph.graphId).artifacts;
  expect(published).toHaveLength(1);
  expect(published[0]?.metadata.code).toMatchObject({ commit: git(worker.path, ['rev-parse', 'HEAD']).stdout.trim() });
  expect((await runtime.artifacts.read(graph.graphId, published[0]!.artifactId, published[0]!.version)).text).toBe('implemented\n');
  expect(git(project, ['rev-parse', 'HEAD']).stdout.trim()).toBe(original);
  expect(await readFile(join(project, 'feature.txt'), 'utf8')).toBe('before\n');
  expect(disk.db.prepare('SELECT state FROM kernel_executions WHERE task_id=?').get(graph.graphId)).toEqual({ state: 'completed' });
  expect(disk.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE task_id=?').get(graph.graphId)).toEqual({ n: 0 });
  expect(disk.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE task_id=?').get(graph.graphId)).toEqual({ n: 0 });
  const transcript = JSON.stringify(provider.requests);
  expect(transcript).toContain('File differs from its commit');
  expect(transcript).toContain('Commit paths must remain inside this node workspace');
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', text: 'Change the working file for a later version, without publishing.' });
  await runtime.host.drive();
  expect(await readFile(join(worker.path, 'feature.txt'), 'utf8')).toBe('later working version\n');
  const previousCommit = git(worker.path, ['rev-parse', 'HEAD']).stdout.trim();
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'start', value: { request: 'Integrate the later working version.' } });
  await runtime.host.drive();
  expect(git(worker.path, ['rev-parse', 'HEAD']).stdout.trim()).not.toBe(previousCommit);
  expect(await readFile(join(integration.path, 'feature.txt'), 'utf8')).toBe('later working version\n');
  expect(git(worker.path, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']).stdout.trim())
    .toBe('Native <native@agents.graph.local>|Native <native@agents.graph.local>');
  expect((await runtime.artifacts.read(graph.graphId, published[0]!.artifactId, published[0]!.version)).text).toBe('implemented\n');
  await main.graphControl({ graphId: graph.graphId, action: 'complete' });
  await runtime.host.drive();
  expect(disk.task(graph.graphId).phase).toBe('blocked');
  expect(git(project, ['rev-parse', 'HEAD']).stdout.trim()).toBe(original);
}, 30000);

/**
 * HB-331 — a `workspace.command` operation reads code out of the integration worktree, so it may
 * only be admitted once the delivery's causal commit is really in that tree. `completed` is not
 * that fact: a source that submitted and then failed to merge has an output but no integration.
 *
 * Both cases run the production path end to end (runtime + real Git worktrees + real broker); no
 * fixture supplies a commit or an integration verdict.
 */
const gateProject = async (root: string) => {
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'feature.txt'), 'before\n');
  // The gate reports what it read on stdout. It writes nothing into the tree it judges, so a clean
  // integration copy stays clean and the operation can still name the commit it verified.
  await writeFile(join(project, 'check.mjs'),
    "import {readFileSync} from 'node:fs'; const value=readFileSync('feature.txt','utf8').trim(); console.log('CHECK_READ='+value); process.exit(value==='implemented'?0:1);\n");
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  return { project, original: git(project, ['rev-parse', 'HEAD']).stdout.trim() };
};

const gateDefinition = () => parseGraphDefinition({ schemaVersion: 2, name: 'gated work',
  protocols: { data: { type: 'object' } },
  nodes: { work: { recipe: 'native@1', task: 'implement feature.txt', inputs: { start: { protocol: 'data' } },
    outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
  modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } },
    outputs: { result: { protocol: 'data' } },
    operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.mjs'], output: 'result' } } },
  edges: { verify: { enabled: true, from: 'work.result', to: 'check.job' } },
  outputs: { result: { from: 'check.result', protocol: 'data' } } });

const gateRuntime = async (root: string, project: string, replies: Parameters<typeof openaiServer>[0]) => {
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const provider = await openaiServer(replies);
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
  const parent = await runtime.user.begin({ projectId: 'p', request: 'gated delivery', requestId: 'parent' });
  return { runtime, main: runtime.supervisor(parent.taskId), stateDir, provider };
};

const implementer = (delayMs: number, explicitCommit: boolean): Parameters<typeof openaiServer>[0] => [
  { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'implemented\n' }) }] },
  // Both ways a node can produce an integrable delivery: an explicit commit, or a submit whose
  // commit only appears when the host settles the workspace.
  ...(explicitCommit ? [{ tools: [{ id: 'commit', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['feature.txt'], message: 'implementation' }) }] }] : []),
  { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { summary: 'implemented' } } } }) }] },
  { text: 'submitted', beforeReply: () => new Promise<void>(resolve => setTimeout(resolve, delayMs)) },
];

test.each([['explicit workspace_commit', true], ['commit only at settle', false]])('HB-331: a check connected to a submission waits for the real merge (%s)', async (_label, explicitCommit) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-gate-wait-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { project, original } = await gateProject(root);
  // The submit lands while the execution is still running: the delivery is dispatched immediately,
  // which is the window the gate used to read the pre-submission tree in.
  const { runtime, main, stateDir } = await gateRuntime(root, project, implementer(2000, explicitCommit));
  const graph = await main.graphCreate({ targetBranch: 'main', definition: gateDefinition() }) as { graphId: string };
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'start', value: {} });
  await runtime.host.drive();
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close());
  const kernel = new KernelStore(disk);
  const integration = disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graph.graphId}`) as { path: string };
  const operations = disk.db.prepare('SELECT state,delivery_id,result FROM kernel_module_operations WHERE task_id=?').all(graph.graphId) as { state: string; delivery_id: string; result: string }[];
  // Exactly one run: a run on the pre-integration tree would have settled on 'before' and failed.
  expect(operations).toHaveLength(1);
  expect(operations[0]!.state).toBe('settled');
  const checked = JSON.parse(operations[0]!.result).outputs.result as { passed: boolean; commit: string; stdout: string };
  expect(checked.passed).toBe(true);
  expect(checked.stdout).toContain('CHECK_READ=implemented');
  // The receipt names the integrated delivery it judged, not the tree it happened to find.
  expect(checked.commit).toBe(disk.task(graph.graphId).integration_sha);
  expect(checked.commit).not.toBe(original);
  // The same delivery continued: one delivery, and the settled operation consumed it.
  const deliveries = disk.db.prepare('SELECT id,submission_id FROM kernel_deliveries WHERE task_id=? AND edge_id=?').all(graph.graphId, 'verify') as { id: string; submission_id: string }[];
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.submission_id).not.toBeNull();
  expect(operations[0]!.delivery_id).toBe(deliveries[0]!.id);
  expect(kernel.nodeState(graph.graphId, 'check').paused).toBe(false);
  expect(disk.db.prepare('SELECT state FROM kernel_executions WHERE task_id=? AND node_id=?').get(graph.graphId, 'work')).toEqual({ state: 'completed' });
  expect(await readFile(join(integration.path, 'feature.txt'), 'utf8')).toBe('implemented\n');
}, 40000);

test('HB-331: a delivery whose source never reached the integration branch blocks the check by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-gate-block-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { project } = await gateProject(root);
  const { runtime, main, stateDir } = await gateRuntime(root, project, implementer(0, true));
  const graph = await main.graphCreate({ targetBranch: 'main', definition: gateDefinition() }) as { graphId: string };
  const disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close());
  const kernel = new KernelStore(disk);
  const integration = disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graph.graphId}`) as { path: string };
  // A competing commit on the integration branch makes the merge conflict for real.
  await writeFile(join(integration.path, 'feature.txt'), 'competing\n');
  git(integration.path, ['-c', 'user.name=Other', '-c', 'user.email=other@local', 'commit', '-qam', 'competing change']);
  await main.graphSend({ graphId: graph.graphId, nodeId: 'work', input: 'start', value: {} });
  await runtime.host.drive();
  // The gate never judged a tree that lacks the delivery it was handed: no operation was dispatched
  // or settled, so nothing ran the command. The block is the visible module pause below.
  const operations = disk.db.prepare('SELECT state FROM kernel_module_operations WHERE task_id=?').all(graph.graphId) as { state: string }[];
  expect(operations.length).toBeGreaterThan(0);
  expect(operations.filter(row => row.state === 'dispatched' || row.state === 'settled')).toEqual([]);
  expect(kernel.nodeState(graph.graphId, 'check').paused).toBe(true);
  const execution = disk.db.prepare('SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1').get(graph.graphId, 'work') as { id: string };
  const failure = disk.db.prepare("SELECT data FROM events WHERE task_id=? AND type='graph.module.failed' ORDER BY cursor DESC LIMIT 1").get(graph.graphId) as { data: string } | undefined;
  expect(failure?.data).toContain(execution.id);
  // The delivery and its input survive the block, so the check can resume on a repaired graph.
  expect(disk.db.prepare('SELECT COUNT(*) AS n FROM kernel_deliveries WHERE task_id=? AND edge_id=?').get(graph.graphId, 'verify')).toEqual({ n: 1 });
  expect(kernel.moduleInput(graph.graphId, 'check', 'job')?.delivered).toBe(true);
}, 40000);
