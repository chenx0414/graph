import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer, type ResponsePlan } from './openai-server.ts';

export function git(root: string, args: string[]) {
  const result = runGit(root, args); if (result.code !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
export const commit = (root: string, message: string) => git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', message]);
export async function nativeGitAcceptance(cleanup: (() => void | Promise<void>)[], options: { review?: 'none' | 'missing' | 'failed' | 'unknown'; sameModel?: boolean; human?: boolean; alternateTarget?: boolean; otherBranch?: boolean; extraWork?: ResponsePlan[]; workPlans?: ResponsePlan[] } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'graph-native-acceptance-')); cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'project'); await mkdir(root);
  await writeFile(join(root, 'README.md'), 'project\n');
  await writeFile(join(root, 'check.cjs'), "if(require('fs').readFileSync('feature.txt','utf8')!=='done')process.exit(1)");
  git(root, ['init', '-q', '-b', 'main']); git(root, ['add', '.']); commit(root, 'baseline'); const baseline = git(root, ['rev-parse', 'HEAD']);
  let target = root;
  if (options.alternateTarget) { git(root, ['checkout', '-qb', 'other']); target = join(parent, 'target'); git(root, ['worktree', 'add', target, 'main']); await writeFile(join(target, 'README.md'), 'human dirty edit\n'); }
  if (options.otherBranch) git(root, ['checkout', '-qb', 'other']);
  const work = await openaiServer(options.workPlans ?? [
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'done' }) }] },
    { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: {} } } }) }] },
    { text: 'Implementation ready' }, ...(options.extraWork ?? []),
  ]); cleanup.push(() => work.close());
  let graphId = ''; let disk!: TaskStore;
  const reviewPlans = (): ResponsePlan[] => options.review === 'unknown' ? [{ text: 'Review usage is unknown', usage: null }] : [
    { tools: [{ id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'feature.txt' }) }] },
    ...(options.review === 'missing' ? [] : [{ tools: [{ id: 'report', name: 'artifact_publish', arguments: () => JSON.stringify({ namespace: 'reviews', name: 'review', schema: 'graph.review@1', mediaType: 'application/json',
      content: JSON.stringify({ commit: disk.task(graphId).integration_sha, passed: options.review !== 'failed', reason: options.review === 'failed' ? 'copy button still shows text' : 'Read the implemented feature at this integration commit' }), requestId: `review-${disk.task(graphId).integration_sha}` }) }] }]),
    { text: 'Review execution complete' },
  ];
  const reviewer = await openaiServer([...reviewPlans(), ...reviewPlans()]); cleanup.push(() => reviewer.close());
  const stateDir = join(parent, 'state'); const capabilityRoot = join(parent, 'capabilities'); await mkdir(capabilityRoot);
  const runtimeOptions = { stateDir, projects: [{ id: 'p', root }], catalog: { capabilityRoot, recipesPath: join(parent, 'recipes.json') },
    limits: { defaultBudgetTokens: 20000000 }, models: { apiKey: 'local-only', modelRuntime: work.runtime, entries: [
      { id: 'work', modelId: 'implementer', provider: work.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: work.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
      { id: 'review', modelId: options.sameModel ? 'implementer' : 'independent', provider: reviewer.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: options.sameModel ? work.model.baseUrl : reviewer.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
    ] } } satisfies Parameters<typeof openTaskRuntime>[0];
  let runtime = await openTaskRuntime(runtimeOptions); cleanup.push(() => runtime.close());
  for (const [id, review] of [['coder', false], ['reviewer', true]] as const) await runtime.catalog.saveAgentCombination({ id, name: id, review, description: id, recommendedGrade: 'medium', tags: [], resources: [], systemPrompt: review ? 'Read the feature and publish an honest review of the current commit.' : 'Implement the assigned feature.' });
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const owner = await runtime.user.begin({ projectId: 'p', request: 'Native acceptance contracts', requestId: 'begin' }); let main = runtime.supervisor(owner.taskId); const data = { protocol: 'data' };
  graphId = ((await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'Native acceptance', protocols: { data: { type: 'object' } }, nodes: {
    work: { recipe: 'coder@1', model: 'work', task: 'Write feature.txt and submit result', inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } },
    review: { recipe: 'reviewer@1', model: 'review', task: 'Read feature.txt and publish the review', inputs: { job: data }, outputs: {}, submission: {} },
  }, modules: { check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.cjs'], output: 'result' } } },
  edges: { workCheck: { from: 'work.result', to: 'check.job', enabled: false }, checkReview: { from: 'check.result', to: 'review.job', enabled: false } },
  acceptance: [{ id: 'works', description: 'feature contains done', kind: 'check', module: 'check' },
    ...(options.review === 'none' ? [] : [{ id: 'review', description: 'Independent review of the exact code commit', kind: 'review', node: 'review' }]),
    ...(options.human ? [{ id: 'human', description: 'Inspect the feature', kind: 'human' }] : [])] }) })) as { graphId: string }).graphId;
  disk = new TaskStore(join(stateDir, 'tasks.sqlite')); cleanup.push(() => disk.close());
  await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
  const check = async () => { await main.graphSend({ graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive(); };
  const review = async () => { await main.graphSend({ graphId, nodeId: 'review', input: 'job', value: {} }); await runtime.host.drive(); };
  const complete = async () => { await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive(); return runtime.user.task(graphId).view(); };
  const acceptance = () => main.graphInspect({ graphId, query: 'acceptance' }) as Promise<{ items: { id: string; status: string; reason: string; source?: { commit: string; id: string } }[] }>;
  return { get runtime() { return runtime; }, get main() { return main; }, graphId, disk, root, target, baseline, stateDir, work, reviewer, check, review, complete, acceptance, async restart() {
    await runtime.close(); runtime = await openTaskRuntime(runtimeOptions); main = runtime.supervisor(owner.taskId); await runtime.host.drive();
  } };
}

