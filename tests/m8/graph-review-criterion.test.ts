import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { git } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A confirmed acceptance cannot be amended, so "code changed but no review criterion was declared"
 * must reach the user as a human criterion. Reported as a non-human constraint it deadlocks: the
 * item can never pass, and the human gate only opens once every non-human item has passed.
 */
test('a code change without a declared review criterion asks the user instead of deadlocking the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-review-criterion-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'feature.txt'), 'before\n');
  git(project, ['init', '-q', '-b', 'main']); git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Fixture', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  let graphId = '';
  let disk: TaskStore | undefined;
  const worker = await openaiServer([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'implemented\n' }) }] },
    { tools: [{ id: 'commit', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['feature.txt'], message: 'implementation' }) }] },
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: {} } } }) }] },
    { text: 'implementation submitted' },
  ]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
    const stateDir = join(root, 'state');
    runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
      limits: { defaultBudgetTokens: 20000000 }, models: { apiKey: 'local-fixture', modelRuntime: worker.runtime, entries: [
        { id: 'worker', modelId: 'implementation-model', provider: worker.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: worker.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
      ] } });
    await runtime.catalog.saveAgentCombination({ id: 'implementer', name: 'implementer', description: 'implementer', recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'Implement feature.txt.' });
    await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
    const parent = await runtime.user.begin({ projectId: 'p', request: 'implement feature', requestId: 'parent' });
    const main = runtime.supervisor(parent.taskId);
    const definition = parseGraphDefinition({ schemaVersion: 2, name: 'no declared review', protocols: { data: { type: 'object' } }, nodes: {
      work: { recipe: 'implementer@1', task: 'implement feature.txt', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } },
    }, modules: {}, edges: {}, acceptance: [{ id: 'human', description: 'inspect the final feature', kind: 'human' }] });
    graphId = ((await main.graphCreate({ definition, targetBranch: 'main' })) as { graphId: string }).graphId;
    disk = new TaskStore(join(stateDir, 'tasks.sqlite'));
    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
    const task = disk.task(graphId);
    expect(task.integration_sha).toBeTruthy();
    expect(task.integration_sha).not.toBe(task.target_sha);
    const assessment = await main.graphInspect({ graphId, query: 'acceptance' }) as { items: { id: string; status: string }[]; human: { id: string }[] };
    expect(assessment.items.find(item => item.id === 'independent-review')).toBeUndefined();
    expect(assessment.human.map(item => item.id)).toContain('independent-review');
    expect(assessment.human.map(item => item.id)).toContain('human');
  } finally { await runtime?.close(); disk?.close(); await worker.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
