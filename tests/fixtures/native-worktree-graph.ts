import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer, type ResponsePlan } from './openai-server.ts';

export function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args); if (result.code !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
const tool = (name: string, value: () => unknown): ResponsePlan => ({ tools: [{ id: name, name, arguments: () => JSON.stringify(value()) }] });

export async function nativeWorktreeGraph(cleanup: (() => Promise<void> | void)[], files: Record<string, { path: string; content: string; workspacePath?: string }>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-worktrees-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  for (const file of Object.values(files)) if (file.workspacePath) { await mkdir(join(project, file.workspacePath), { recursive: true }); await writeFile(join(project, file.workspacePath, '.gitkeep'), ''); }
  await writeFile(join(project, 'README.md'), 'project\n');
  await writeFile(join(project, 'check.cjs'), `const fs=require('fs');for(const f of ${JSON.stringify(Object.values(files).map(file => ({ path: file.workspacePath ? join(file.workspacePath, file.path) : file.path, content: file.content })))})if(fs.readFileSync(f.path,'utf8')!==f.content)process.exit(1);`);
  git(project, ['init', '-q', '-b', 'main']); git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  const baseline = git(project, ['rev-parse', 'HEAD']);
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>; let graphId = ''; let disk!: TaskStore;
  const providers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  let arrived = 0; let release!: () => void;
  const simultaneous = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
  for (const [id, file] of Object.entries(files)) {
    providers[id] = await openaiServer([
      { ...tool('write_file', () => ({ path: file.path, content: file.content })), beforeReply: async () => { if (++arrived === Object.keys(files).length) release(); await simultaneous; } },
      tool('workspace_commit', () => ({ paths: [file.path], message: `Implement ${id}` })),
      tool('artifact_publish', () => ({ namespace: 'deliverables', name: id, sourcePath: file.path, metadata: { kind: 'code' }, requestId: `publish-${id}` })),
      { text: `${id} implementation complete` },
    ]); cleanup.push(() => providers[id]!.close());
  }
  const references = () => runtime.artifacts.list(graphId, { namespace: 'deliverables' }).artifacts.map(item => ({ artifactId: item.artifactId, version: item.version, digest: item.digest }));
  const reviewer = await openaiServer([
    ...Object.keys(files).map((_, i) => tool('artifact_read', () => references()[i]!)),
    tool('artifact_publish', () => ({ namespace: 'reviews', name: 'review', schema: 'graph.review@1', mediaType: 'application/json',
      content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: true, reason: 'Read all published code versions and checked their intended content.' }), requestId: 'review' })),
    { text: 'Reviewed the current integrated commit.' },
  ]); cleanup.push(() => reviewer.close());
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const runtimeOptions = { stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }],
    catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') }, models: { apiKey: 'local-only', modelRuntime: reviewer.runtime,
      entries: [...Object.entries(providers), ['review', reviewer] as const].map(([id, provider]) => ({ id, modelId: `${id}-identity`, provider: provider.model.provider,
        grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })) },
  } satisfies Parameters<typeof openTaskRuntime>[0];
  runtime = await openTaskRuntime(runtimeOptions); cleanup.push(() => runtime.close());
  for (const [id, name, review] of [['coder', '代码实现', false], ['reviewer', '独立审查', true]] as const) await runtime.catalog.saveAgentCombination({
    id, name, review, description: name, recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: review ? 'Read each immutable code artifact and publish an independent review.' : 'Write, commit and publish the assigned file.' });
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Native worktree integration', requestId: 'begin' });
  let main = runtime.supervisor(owner.taskId); const data = { protocol: 'data' };
  graphId = ((await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'Worktree contracts',
    protocols: { data: { type: 'object' } }, nodes: {
      ...Object.fromEntries(Object.keys(files).map(id => [id, { recipe: 'coder@1', model: id, task: `Write, commit and publish ${files[id]!.path}`,
        ...(files[id]!.workspacePath ? { workspace: { base: 'worktree', path: files[id]!.workspacePath } } : {}),
        inputs: { job: data }, outputs: {}, submission: {} }])),
      review: { recipe: 'reviewer@1', model: 'review', task: 'Review the published code versions and current integration commit.', inputs: { job: data }, outputs: {}, submission: {} },
    }, modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.cjs'], output: 'result' } } }, edges: {},
    acceptance: [{ id: 'works', description: 'All integrated files contain the assigned content', kind: 'check', module: 'check' },
      { id: 'review', description: 'Independent review of the exact integrated commit', kind: 'review', node: 'review' }],
  }) })) as { graphId: string }).graphId;
  disk = new TaskStore(join(root, 'state', 'tasks.sqlite')); cleanup.push(() => disk.close());
  const tree = (id: string) => (disk.db.prepare('SELECT path FROM worktrees WHERE task_id=? AND node_id=?').get(graphId, id) as { path: string }).path;
  return { get runtime() { return runtime; }, get main() { return main; }, graphId, project, baseline, disk, providers, reviewer, tree, references,
    async reopen() { await runtime.close(); runtime = await openTaskRuntime(runtimeOptions); main = runtime.supervisor(owner.taskId); },
    async work() { for (const id of Object.keys(files)) await main.graphSend({ graphId, nodeId: id, input: 'job', value: files[id]! }); await runtime.host.drive(); },
    async finish() {
      await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
      await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: { subjects: references() } }); await runtime.host.drive();
      await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
      return runtime.user.task(graphId).view();
    },
  };
}

