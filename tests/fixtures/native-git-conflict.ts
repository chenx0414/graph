import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { GitIntegration } from '../../src/git/integration.ts';
import { openaiServer } from './openai-server.ts';
import { git as runGit, mergeConflictFiles } from '../../src/git/git.ts';

export function git(root: string, args: string[]) {
  const result = runGit(root, args); if (result.code !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
export const combined = 'a\nfrom-main\nfrom-lane\nc\n';
const commit = (root: string, message: string) => git(root, ['-c', 'user.name=Main', '-c', 'user.email=main@local', 'commit', '-qm', message]);

// The Git infrastructure boundary: main performs explicit repository operations.
// Formal checks and delivery still run through the native graph, never a resolver callback.
export async function nativeGitConflict(cleanup: (() => Promise<void> | void)[]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-explicit-conflict-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'shared.txt'), 'a\nb\nc\n'); await writeFile(join(project, 'other.txt'), 'untouched\n');
  await writeFile(join(project, 'verify.cjs'), `const fs=require('fs');const text=fs.readFileSync('shared.txt','utf8');if(text!==${JSON.stringify(combined)}||fs.readFileSync('other.txt','utf8')!=='untouched\\n')process.exit(1);`);
  git(project, ['init', '-q', '-b', 'main']); git(project, ['add', '.']); commit(project, 'baseline'); const baseline = git(project, ['rev-parse', 'HEAD']);
  const stateDir = join(root, 'state'); const capabilities = join(root, 'capabilities'); await mkdir(capabilities);
  let graphId = ''; let disk!: TaskStore;
  const reviewer = await openaiServer([
    { tools: [{ id: 'read-both', name: 'read_file', arguments: JSON.stringify({ path: 'shared.txt' }) }, { id: 'read-other', name: 'read_file', arguments: JSON.stringify({ path: 'other.txt' }) }] },
    { tools: [{ id: 'review-report', name: 'artifact_publish', arguments: () => JSON.stringify({ namespace: 'reviews', name: 'review', schema: 'graph.review@1', mediaType: 'application/json',
      content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: true, reason: 'Read both preserved contributions and the unchanged unrelated file.' }), requestId: 'review' }) }] },
    { text: 'Independent review of the explicit resolution complete.' },
  ]); cleanup.push(() => reviewer.close());
  const runtime = await openTaskRuntime({ stateDir, models: { apiKey: 'local-only', modelRuntime: reviewer.runtime, entries: [{ id: 'review', modelId: 'independent-review',
    provider: reviewer.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: reviewer.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] }, projects: [{ id: 'p', root: project }], catalog: { capabilityRoot: capabilities, recipesPath: join(root, 'recipes.json') } });
  cleanup.push(() => runtime.close());
  await runtime.catalog.saveAgentCombination({ id: 'coder', name: 'Code author', review: false, description: 'Code author', recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: 'Preserve both sides.' });
  await runtime.catalog.saveAgentCombination({ id: 'reviewer', name: 'Independent reviewer', review: true, description: 'Independent reviewer', recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: 'Read the resolution and publish an independent review of its commit.' });
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Explicit conflict handling', requestId: 'begin' }); const main = runtime.supervisor(owner.taskId);
  const port = { protocol: 'data' }; const node = { recipe: 'coder@1', task: 'Preserve both sides', inputs: { job: port }, outputs: {}, submission: {} };
  graphId = ((await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'Explicit conflict handling',
    protocols: { data: { type: 'object' } }, nodes: { a: node, b: node, review: { ...node, recipe: 'reviewer@1', model: 'review' } }, modules: { check: { type: 'operation', trigger: 'each', inputs: { job: port }, outputs: { result: port },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['verify.cjs'], output: 'result' } } }, edges: {},
    acceptance: [{ id: 'preserved', description: 'Both contributions survive and unrelated content stays intact', kind: 'check', module: 'check' }, { id: 'review', description: 'Independent review of the explicit resolution', kind: 'review', node: 'review' }],
  }) })) as { graphId: string }).graphId;
  disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close()); const integration = new GitIntegration(disk, stateDir);
  const instance = (id: string) => (disk.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, id) as { instance_id: string }).instance_id;
  const trees = { a: integration.workspace(graphId, instance('a'), 'a', 'agent', 'work')!, b: integration.workspace(graphId, instance('b'), 'b', 'agent', 'work')! };
  const integrationTree = integration.workspace(graphId, null, 'integration', 'program')!;
  let operation = 0;
  const integrate = (id: 'a' | 'b') => integration.integrate({ id: `main-git-${++operation}`, taskId: graphId, nodeId: id, instanceId: instance(id), kind: 'agent', recipe: 'coder@1' });
  return { runtime, main, disk, graphId, project, baseline, trees, integrationTree, integration, instance, integrate,
    async collide() {
      await writeFile(join(trees.a, 'shared.txt'), 'a\nfrom-main\nc\n'); await writeFile(join(trees.b, 'shared.txt'), 'a\nfrom-lane\nc\n');
      expect(integrate('a')?.ok).toBe(true); const before = git(integrationTree, ['rev-parse', 'HEAD']);
      const refused = integrate('b'); expect(refused).toMatchObject({ ok: false, conflicts: ['shared.txt'] });
      expect(git(integrationTree, ['rev-parse', 'HEAD'])).toBe(before); expect(mergeConflictFiles(integrationTree)).toEqual([]);
      return before;
    },
    async resolve(content: string, other?: string) {
      const integrationBranch = disk.task(graphId).integration_branch!;
      const merge = runGit(trees.b, ['merge', '--no-commit', '--no-ff', integrationBranch]); expect(merge.code).toBe(1);
      expect(mergeConflictFiles(trees.b)).toContain('shared.txt');
      await writeFile(join(trees.b, 'shared.txt'), content); if (other !== undefined) await writeFile(join(trees.b, 'other.txt'), other);
      git(trees.b, ['add', '.']); commit(trees.b, 'Explicit main conflict resolution');
      const sha = git(trees.b, ['rev-parse', 'HEAD']); expect(integrate('b')).toMatchObject({ ok: true, sha }); return sha;
    },
    async check() { await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive(); return main.graphInspect({ graphId, query: 'acceptance' }); },
    async review() { await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive(); expect(reviewer.requests).toHaveLength(3); },
    async finish() { await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); return runtime.user.task(graphId).view(); },
  };
}

