import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { git as runGit } from '../../src/git/git.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const harness = fileURLToPath(new URL('../../examples/m7-acceptance.ts', import.meta.url));

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function runHarness(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harness], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function fixtureRepo(parent: string) {
  const source = join(parent, 'source');
  await mkdir(source);
  git(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'package.json'), `${JSON.stringify({ name: 'm7-harness-fixture', private: true }, null, 2)}\n`);
  await writeFile(join(source, 'README.md'), 'MediaBookmarks fixture\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'fixture']);
  return source;
}

const proposal = {
  requirementVersion: 1, summary: 'Confirm code checks, review and isolated login',
  acceptance: [
    { id: 'tests', description: 'The web tests pass', checkNode: 'check' },
    { id: 'review', description: 'Independent review', checkNode: 'review' },
    { id: 'human-login', description: 'User confirmed login in the isolated profile', checkNode: 'review' },
  ],
  definition: parseGraphDefinition({ schemaVersion: 2, name: 'M7 native', protocols: { data: { type: 'object' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'worker', task: 'Implement the file', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
      review: { recipe: 'reviewer@1', model: 'reader', task: 'Review the current commit', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
        deliverable: { path: 'review.json', namespace: 'reviews', name: 'review', schema: 'graph.review@1' } },
    }, modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.cjs'], output: 'result' } } },
    edges: { checked: { from: 'check.result', to: 'review.job', enabled: true } },
    acceptance: [
      { id: 'tests', description: 'The web tests pass', kind: 'check', module: 'check' },
      { id: 'review', description: 'Independent review', kind: 'review', node: 'review' },
      { id: 'human-login', description: 'User confirmed login in the isolated profile', kind: 'human' },
    ],
  }),
};

interface Summary {
  step: string;
  taskId: string;
  graphId: string | null;
  mainTaskId: string;
  conversationId: string;
  mainQuestions: Summary['questions'];
  taskCount: number;
  phase: string;
  proposalVersion: number;
  acceptedProposalVersion: number | null;
  integrationSha: string | null;
  acceptance: { id: string; status: string; source?: { commit?: string | null } }[];
  questions: { id: string; nodeId: string; kind: string; status: string; data: { activationId?: string; commitSha?: string | null } }[];
  cost: unknown;
  costSource: string;
  invocationCount: number;
  answeredChecks: { questionId: string }[];
  resume?: string;
}

async function summary(workDir: string) {
  return JSON.parse(await readFile(join(workDir, 'acceptance-report.json'), 'utf8')).summary as Summary;
}

test('the native harness resumes one conversation and graph, rejects stale confirmation and binds human acceptance to the new commit', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-harness-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const source = await fixtureRepo(parent);
  await writeFile(join(source, 'check.cjs'), "if(require('fs').readFileSync('feature.txt','utf8')!=='implemented')process.exit(1)");
  git(source, ['add', '.']); git(source, ['commit', '-m', 'check']);
  const workDir = join(parent, 'run'), project = join(workDir, 'project');
  const mainProvider = await openaiServer([
    { tools: [{ id: 'proposal', name: 'propose_graph', arguments: JSON.stringify({ proposal, requestId: 'm7-plan' }) }] },
    { text: 'Native draft ready.' },
    ...Array.from({ length: 20 }, () => ({ text: 'The graph is waiting for explicit work or user acceptance.' })),
  ]);
  cleanup.push(() => mainProvider.close());
  const report = () => {
    const state = JSON.parse(requireState());
    const store = new TaskStore(join(workDir, 'state', 'tasks.sqlite'));
    try { return JSON.stringify({ commit: store.task(state.graphId).integration_sha, passed: true, reason: 'Current implementation reviewed independently' }); }
    finally { store.close(); }
  };
  // Provider scripts produce real files; the host publishes and verifies their bytes.
  const nodes = await openaiServer([
    { tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'feature.txt', content: 'implemented' }) }] }, { text: 'Implemented.' },
    { tools: [{ id: 'review', name: 'write_file', arguments: () => JSON.stringify({ path: 'review.json', content: report() }) }] }, { text: 'Reviewed.' },
    { tools: [{ id: 'write-next', name: 'write_file', arguments: JSON.stringify({ path: 'revision-marker.txt', content: 'moved\n' }) }] }, { text: 'Updated.' },
    { tools: [{ id: 'review-next', name: 'write_file', arguments: () => JSON.stringify({ path: 'review.json', content: report() }) }] }, { text: 'Reviewed again.' },
  ]);
  cleanup.push(() => nodes.close());
  nodes.runtime.registerProvider('graph-openai', { baseUrl: nodes.model.baseUrl, api: 'openai-completions', apiKey: 'scripted-local-key', models: [nodes.model, { ...nodes.model, id: 'worker' }, { ...nodes.model, id: 'reader' }] });
  nodes.runtime.registerProvider('graph-m7', { baseUrl: mainProvider.model.baseUrl, api: 'openai-completions', apiKey: 'scripted-local-key', models: [mainProvider.model] });
  const env = { GRAPH_M7_MODEL_BASE_URL: mainProvider.model.baseUrl, GRAPH_M7_MODEL_API_KEY: 'scripted-local-key',
    GRAPH_M7_MODEL_ID: 'local', GRAPH_M7_REVIEW_MODEL_ID: 'reader', GRAPH_M7_WORKDIR: workDir, GRAPH_MEDIABOOKMARKS_ROOT: source };
  expect((await runHarness(env)).code).toBe(1);
  expect(JSON.stringify(mainProvider.requests[0])).toContain('work 使用 local，review 使用 reader');
  const proposed = await summary(workDir);
  expect(proposed).toMatchObject({ step: 'awaiting-confirmation', graphId: null, taskCount: 0, proposalVersion: 1 });
  expect((await runHarness({ ...env, GRAPH_M7_ACCEPT: '99' })).code).toBe(1);
  expect((await summary(workDir)).acceptedProposalVersion).toBeNull();
  expect((await runHarness({ ...env, GRAPH_M7_ACCEPT: '1' })).code).toBe(1);
  const accepted = await summary(workDir);
  expect(accepted).toMatchObject({ step: 'awaiting-work', taskCount: 1, acceptedProposalVersion: 1 });
  expect(accepted.taskId).not.toBe(accepted.mainTaskId);
  const acceptedIds = { graphId: accepted.graphId, mainTaskId: accepted.mainTaskId, conversationId: accepted.conversationId };
  const sentBeforeRecovery = mainProvider.requests.length;
  await rm(join(workDir, 'run.json'));
  expect((await runHarness(env)).code).toBe(1);
  expect(await summary(workDir)).toMatchObject({ ...acceptedIds, taskCount: 1, acceptedProposalVersion: 1 });
  expect(mainProvider.requests.length).toBe(sentBeforeRecovery);
  let stateText = await readFile(join(workDir, 'run.json'), 'utf8');
  function requireState() { return stateText; }
  const state = JSON.parse(stateText) as { graphId: string; taskId: string; conversationId: string };
  const runRound = async (second: boolean) => {
    const runtime = await openTaskRuntime({ stateDir: join(workDir, 'state'), projects: [{ id: 'media-bookmarks', root: project }],
      models: { apiKey: 'scripted-local-key', modelRuntime: nodes.runtime, entries: [
        { id: 'local', provider: 'graph-m7', grade: 'high', api: 'openai-completions', baseUrl: mainProvider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
        ...['worker', 'reader'].map(id => ({ id, provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: nodes.model.baseUrl, contextWindow: 32000, maxTokens: 256 })),
      ] } });
    try {
      const main = runtime.supervisor(state.taskId);
      if (second) await main.graphControl({ graphId: state.graphId, action: 'withdraw_complete' });
      await main.graphSend({ graphId: state.graphId, nodeId: 'work', input: 'job', value: {} }); await runtime.host.drive();
      await main.graphSend({ graphId: state.graphId, nodeId: 'check', input: 'job', value: {} }); await runtime.host.drive();
      await main.graphControl({ graphId: state.graphId, action: 'complete' }); await runtime.host.drive();
    } finally { await runtime.close(); }
  };
  await runRound(false);
  expect((await runHarness(env)).code).toBe(1);
  const waiting = await summary(workDir);
  expect(waiting.step).toBe('awaiting-human-check');
  const firstQuestion = waiting.questions.find(q => q.kind === 'human_check' && q.status === 'open')!;
  expect(firstQuestion.data.commitSha).toBe(waiting.integrationSha);
  await runRound(true);
  stateText = await readFile(join(workDir, 'run.json'), 'utf8');
  expect((await runHarness({ ...env, GRAPH_M7_LOGIN_CONFIRMED: firstQuestion.id })).code).toBe(1);
  const recheck = await summary(workDir);
  expect(recheck.integrationSha).not.toBe(waiting.integrationSha);
  expect(recheck.answeredChecks).toEqual([]);
  const current = recheck.questions.filter(q => q.kind === 'human_check' && q.status === 'open');
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(firstQuestion.id);
  expect(current[0]!.data.commitSha).toBe(recheck.integrationSha);
  expect((await runHarness({ ...env, GRAPH_M7_LOGIN_CONFIRMED: current[0]!.id })).code).toBe(0);
  const completed = await summary(workDir);
  expect(completed).toMatchObject({ step: 'result', phase: 'completed', taskCount: 1 });
  expect(completed.acceptance.map(item => [item.id, item.status, item.source?.commit])).toEqual([
    ['tests', 'passed', completed.integrationSha], ['review', 'passed', completed.integrationSha], ['human-login', 'passed', completed.integrationSha],
  ]);
  expect(await readFile(join(project, 'revision-marker.txt'), 'utf8')).toBe('moved\n');
  const sent = mainProvider.requests.length + nodes.requests.length;
  expect((await runHarness(env)).code).toBe(0);
  expect(mainProvider.requests.length + nodes.requests.length).toBe(sent);
  expect((await summary(workDir)).conversationId).toBe(state.conversationId);
  await writeFile(join(workDir, 'run.json'), JSON.stringify({ version: 1, taskId: state.taskId }));
  const legacy = await runHarness(env);
  expect(legacy.code).toBe(2);
  expect(legacy.stderr).toContain('Unsupported legacy run state');
  expect(mainProvider.requests.length + nodes.requests.length).toBe(sent);
}, 240000);

test('the harness can acknowledge a recorded reservation overrun without re-planning', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-overrun-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const source = await fixtureRepo(parent);
  const workDir = join(parent, 'run');
  const provider = await openaiServer([
    { tools: [{ id: 'p1', name: 'propose_graph', arguments: JSON.stringify({ proposal, requestId: 'm7-plan' }) }], usage: { prompt_tokens: 2_100_000, completion_tokens: 5 } },
    { text: 'Proposed the Bilibili web graph.', usage: { prompt_tokens: 1_000, completion_tokens: 5 } },
    { text: '请确认当前提案。' }, // Conversation composer suggestion, not another main execution.
  ]);
  cleanup.push(() => provider.close());
  const env = {
    GRAPH_M7_MODEL_BASE_URL: provider.model.baseUrl,
    GRAPH_M7_MODEL_API_KEY: 'scripted-local-key',
    GRAPH_M7_MODEL_ID: 'local',
    GRAPH_M7_REVIEW_MODEL_ID: 'reader',
    GRAPH_M7_WORKDIR: workDir,
    GRAPH_MEDIABOOKMARKS_ROOT: source,
  };
  const first = await runHarness(env);
  expect(first.code).toBe(1);
  const proposed = await summary(workDir);
  expect(proposed.step).toBe('awaiting-confirmation');
  expect(proposed.mainQuestions.some(question => question.kind === 'reservation_exceeded' && question.status === 'open')).toBe(true);

  const requestsBeforeAcknowledgement = provider.requests.length;
  const acknowledged = await runHarness({ ...env, GRAPH_M7_ACKNOWLEDGE_OVERRUN: '1' });
  expect(acknowledged.code).toBe(1);
  const after = await summary(workDir);
  expect(after.step).toBe('awaiting-confirmation');
  expect(after.mainQuestions.some(question => question.kind === 'reservation_exceeded' && question.status === 'open')).toBe(false);
  expect(after.acceptedProposalVersion).toBeNull();
  expect(after.proposalVersion).toBe(1);
  expect(provider.requests.length).toBe(requestsBeforeAcknowledgement);
}, 120_000);
