import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('native final acceptance binds real checks, independent published review and user approval before exact Git delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-final-acceptance-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'feature.txt'), 'before\n');
  await writeFile(join(project, 'check.cjs'), "if(require('fs').readFileSync('feature.txt','utf8')!=='implemented\\n')process.exit(1)");
  git(project, ['init', '-q', '-b', 'main']); git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  const baseline = git(project, ['rev-parse', 'HEAD']).stdout.trim();
  let graphId = '';
  let disk: TaskStore | undefined;
  const code = () => disk!.db.prepare("SELECT artifact_id,version FROM artifacts WHERE task_id=? AND namespace='deliverables' ORDER BY version DESC LIMIT 1").get(graphId) as { artifact_id: string; version: number };
  const worker = await openaiServer([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'implemented\n' }) }] },
    { tools: [{ id: 'commit', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['feature.txt'], message: 'implementation' }) }] },
    { tools: [{ id: 'publish', name: 'artifact_publish', arguments: JSON.stringify({ namespace: 'deliverables', name: 'code', sourcePath: 'feature.txt', metadata: { kind: 'code' }, requestId: 'code' }) }] },
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: {} } } }) }] },
    { text: 'implementation submitted' },
  ]);
  const reviewer = await openaiServer([
    { tools: [{ id: 'read', name: 'artifact_read', arguments: () => JSON.stringify({ artifactId: code().artifact_id, version: code().version }) }] },
    { tools: [{ id: 'report', name: 'artifact_publish', arguments: () => JSON.stringify({ namespace: 'reviews', name: 'review', schema: 'graph.review@1', mediaType: 'application/json',
      content: JSON.stringify({ commit: baseline, passed: true, reason: 'Earlier commit passed' }), requestId: 'old-review' }) }] },
    { text: 'earlier review published' },
    { tools: [{ id: 'read-current', name: 'artifact_read', arguments: () => JSON.stringify({ artifactId: code().artifact_id, version: code().version }) }] },
    { tools: [{ id: 'current-report', name: 'artifact_publish', arguments: () => JSON.stringify({ namespace: 'reviews', name: 'review', schema: 'graph.review@1', mediaType: 'application/json',
      content: JSON.stringify({ commit: disk!.task(graphId).integration_sha, passed: true, reason: 'Published feature matches the requirement' }), expectedVersion: 1, requestId: 'current-review' }) }] },
    { text: 'current review published' },
  ]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
    const stateDir = join(root, 'state');
    runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
      limits: { defaultBudgetTokens: 20000000 }, models: { apiKey: 'local-fixture', modelRuntime: worker.runtime, entries: [
        { id: 'worker', modelId: 'implementation-model', provider: worker.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: worker.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
        { id: 'reviewer', modelId: 'independent-model', provider: worker.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: reviewer.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
      ] } });
    for (const [id, review] of [['implementer', false], ['reviewer', true]] as const) await runtime.catalog.saveAgentCombination({
      id, name: id, description: id, recommendedGrade: 'medium', review, tags: [], resources: [], systemPrompt: review ? 'Read and review the published implementation.' : 'Implement feature.txt.' });
    await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
    const parent = await runtime.user.begin({ projectId: 'p', request: 'implement and verify feature', requestId: 'parent' });
    const main = runtime.supervisor(parent.taskId);
    const definition = parseGraphDefinition({ schemaVersion: 2, name: 'final acceptance', protocols: { data: { type: 'object' } }, nodes: {
      work: { recipe: 'implementer@1', task: 'implement feature.txt', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
      review: { recipe: 'reviewer@1', task: 'review the published implementation and publish graph.review@1', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
    }, modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.cjs'], output: 'result' } } },
    edges: { relation: { from: 'work.result', to: 'review.job', enabled: false } }, acceptance: [
      { id: 'behavior', description: 'feature contains implemented', kind: 'check', module: 'check' },
      { id: 'review', description: 'independent review of this commit', kind: 'review', node: 'review' },
      { id: 'human', description: 'inspect the final feature', kind: 'human' },
    ] });
    graphId = ((await main.graphCreate({ definition, targetBranch: 'main' })) as { graphId: string }).graphId;
    disk = new TaskStore(join(stateDir, 'tasks.sqlite'));
    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    expect(disk.task(graphId).phase).toBe('blocked');
    expect(disk.db.prepare("SELECT id FROM questions WHERE task_id=? AND kind='human_check'").get(graphId)).toBeUndefined();
    await main.graphControl({ graphId, action: 'withdraw_complete' });
    await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
    await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive();
    const stale = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
    expect(stale.items.find(item => item.id === 'review')?.status).toBe('stale');
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    expect(disk.task(graphId).phase).toBe('blocked');
    expect(disk.db.prepare("SELECT id FROM questions WHERE task_id=? AND kind='human_check'").get(graphId)).toBeUndefined();
    await main.graphControl({ graphId, action: 'withdraw_complete' });
    await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive();
    const assessment = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[] };
    expect(assessment.items.map(item => [item.id, item.status])).toEqual([['behavior', 'passed'], ['review', 'passed'], ['human', 'missing']]);
    expect(JSON.stringify(reviewer.requests)).toContain('implemented');
    expect(JSON.stringify(reviewer.requests)).toContain('FINAL REVIEW REQUIREMENTS');
    const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { nodeId: string; model: { recipe: { definition: string; review: boolean } } }[];
    expect(calls.filter(call => call.nodeId === 'work').every(call => call.model.recipe.definition === 'implementer@1' && !call.model.recipe.review)).toBe(true);
    expect(calls.filter(call => call.nodeId === 'review').every(call => call.model.recipe.definition === 'reviewer@1' && call.model.recipe.review)).toBe(true);
    expect(disk.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE task_id=? AND schema_kind='graph.review'").get(graphId)).toEqual({ n: 2 });
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    const question = disk.db.prepare("SELECT id,data FROM questions WHERE task_id=? AND kind='human_check' AND status='open'").get(graphId) as { id: string; data: string };
    const verified = disk.task(graphId).integration_sha!;
    expect(JSON.parse(question.data)).toMatchObject({ acceptanceId: 'human', commitSha: verified });
    await writeFile(join(project, 'user.txt'), 'user-owned change');
    await runtime.user.task(graphId).answer(question.id, { type: 'acknowledge' }, 'accept'); await runtime.host.drive();
    expect(disk.task(graphId).phase).toBe('blocked');
    expect(git(project, ['rev-parse', 'HEAD']).stdout.trim()).toBe(baseline);
    expect(await readFile(join(project, 'user.txt'), 'utf8')).toBe('user-owned change');
    await rm(join(project, 'user.txt'));
    const integration = (disk.db.prepare('SELECT path FROM worktrees WHERE instance_id=?').get(`integration:${graphId}`) as { path: string }).path;
    await writeFile(join(integration, 'unchecked-commit.txt'), 'unchecked commit');
    git(integration, ['add', 'unchecked-commit.txt']);
    git(integration, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'unverified advance']);
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    expect(disk.task(graphId).phase).toBe('blocked');
    expect(git(project, ['rev-parse', 'HEAD']).stdout.trim()).toBe(baseline);
    // Restore only this disposable fixture; the accepted SHA and its evidence remain unchanged.
    git(integration, ['reset', '--hard', verified]);
    await writeFile(join(integration, 'unchecked.txt'), 'unchecked change');
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    expect(disk.task(graphId).phase).toBe('blocked');
    expect(git(project, ['rev-parse', 'HEAD']).stdout.trim()).toBe(baseline);
    await rm(join(integration, 'unchecked.txt'));
    await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
    expect(disk.task(graphId).phase).toBe('completed');
    expect(git(project, ['rev-parse', 'HEAD']).stdout.trim()).toBe(verified);
    expect(await readFile(join(project, 'feature.txt'), 'utf8')).toBe('implemented\n');
    expect(disk.db.prepare('SELECT commit_sha FROM kernel_completion_delivery WHERE task_id=?').get(graphId)).toEqual({ commit_sha: verified });
    expect(disk.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE task_id=?').get(graphId)).toEqual({ n: 0 });
  } finally { await runtime?.close(); disk?.close(); await worker.close(); await reviewer.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
