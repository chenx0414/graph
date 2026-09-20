import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
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

const reviewBody = '# Independent review\n\nThe Bilibili web passes the frozen checks.\n';
const reviewDigest = createHash('sha256').update(reviewBody).digest('hex');

const proposal = {
  requirementVersion: 1,
  summary: '本机 Web 复用 CLI：登录态、采集进度与失败原因、收藏与笔记、Markdown 导出。',
  acceptance: [
    { id: 'tests', description: 'The web tests pass', checkNode: 'check' },
    { id: 'human-login', description: 'User confirmed login in the isolated profile', checkNode: 'login' },
  ],
  nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
    { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['--test', 'test/web.test.js'] } },
    { id: 'review', kind: 'agent', action: 'review', definitionVersion: 'reviewer@1', model: 'reader', dependsOn: ['check'] },
    { id: 'review-gate', kind: 'program', action: 'graph.verify', dependsOn: ['review'], verifier: { kind: 'independent', reportNodes: ['review'] } },
    { id: 'login', kind: 'program', action: 'graph.human_check', dependsOn: ['review-gate'] },
  ],
};

function plans() {
  const webTest = "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('web works', () => assert.equal(1, 1));\n";
  const reviewDecision = JSON.stringify({
    schemaVersion: 1,
    body: { kind: 'independent', verdict: 'pass', reason: 'Independent review of the Bilibili web', evidence: [{ path: '/tmp/graph-m7-review.md', digest: reviewDigest }] },
  });
  const reviewTools = { tools: [
    { id: 'r1', name: 'write', arguments: JSON.stringify({ path: 'docs/review.md', content: reviewBody }) },
    { id: 'r2', name: 'submit_result', arguments: JSON.stringify({ outputJson: reviewDecision }) },
  ] };
  return [
    { tools: [{ id: 'p1', name: 'propose_graph', arguments: JSON.stringify({ proposalJson: JSON.stringify(proposal), requestId: 'm7-plan' }) }] },
    { text: 'Proposed the Bilibili web graph.' },
    { tools: [{ id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'test/web.test.js', content: webTest }) }] },
    { text: 'Wrote the web tests.' },
    reviewTools,
    { text: 'Review submitted.' },
    { tools: [{ id: 'w2', name: 'write', arguments: JSON.stringify({ path: 'revision-marker.txt', content: 'moved\n' }) }] },
    { text: 'Moved the target after the login check.' },
    reviewTools,
    { text: 'Review submitted again.' },
  ];
}

interface Summary {
  step: string;
  taskId: string;
  taskCount: number;
  phase: string;
  proposalVersion: number;
  acceptedProposalVersion: number | null;
  integrationSha: string | null;
  acceptance: { id: string; valid: boolean; commitSha?: string | null }[];
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

test('the acceptance harness reuses one task, refuses stale confirmations, and completes after a target move', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-harness-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const source = await fixtureRepo(parent);
  const workDir = join(parent, 'run');
  const project = join(workDir, 'project');
  const provider = await openaiServer(plans());
  cleanup.push(() => provider.close());
  const env = {
    GRAPH_M7_MODEL_BASE_URL: provider.model.baseUrl,
    GRAPH_M7_MODEL_API_KEY: 'scripted-local-key',
    GRAPH_M7_MODEL_ID: 'local',
    GRAPH_M7_REVIEW_MODEL_ID: 'reader',
    GRAPH_M7_WORKDIR: workDir,
    GRAPH_MEDIABOOKMARKS_ROOT: source,
  };

  // 1. Stops before confirmation and shows the full proposal.
  const first = await runHarness(env);
  expect(first.code).toBe(1);
  const proposed = await summary(workDir);
  expect(proposed.step).toBe('awaiting-confirmation');
  expect(proposed.taskCount).toBe(1);
  expect(proposed.acceptedProposalVersion).toBeNull();
  expect(proposed.proposalVersion).toBe(1);
  expect(proposed.resume).toContain('GRAPH_M7_ACCEPT=1');
  const state = JSON.parse(await readFile(join(workDir, 'run.json'), 'utf8')) as { taskId: string; acceptedProposalVersion: number | null };
  expect(state.taskId).toBe(proposed.taskId);

  // 2. A stale or wrong confirmation value never confirms the current proposal.
  const wrong = await runHarness({ ...env, GRAPH_M7_ACCEPT: '99' });
  expect(wrong.code).toBe(1);
  expect((await summary(workDir)).step).toBe('awaiting-confirmation');
  expect((await summary(workDir)).acceptedProposalVersion).toBeNull();

  // 3. The exact proposal version confirms and the run stops at the human login check.
  const accepted = await runHarness({ ...env, GRAPH_M7_ACCEPT: String(proposed.proposalVersion) });
  expect(accepted.code).toBe(1);
  const waiting = await summary(workDir);
  expect(waiting.step).toBe('awaiting-human-check');
  expect(waiting.phase).toBe('running');
  const firstQuestions = waiting.questions.filter(question => question.status === 'open' && question.kind === 'human_check');
  expect(firstQuestions).toHaveLength(1);
  const firstQuestion = firstQuestions[0]!;
  const firstSha = waiting.integrationSha;
  expect(firstQuestion.data.commitSha).toBe(firstSha);
  expect(provider.requests.length).toBe(6);

  // 4. The target moves after the check was raised, without touching the confirmed check input.
  const runtime = await openTaskRuntime({ stateDir: join(workDir, 'state'), projects: [{ id: 'media-bookmarks', root: project }] });
  try {
    const view = await runtime.user.task(state.taskId).view();
    await runtime.supervisor(state.taskId).revise({
      baseVersion: view.graphVersion,
      reason: 'Move the target after the login check was raised',
      nodes: view.proposal!.nodes.map(node => node.id === 'work' ? { ...node, input: { revision: 2 } } : node),
      requestId: 'move-target',
    });
  } finally { await runtime.close(); }

  // 5. The old question id is superseded cleanup, never a confirmation of the moved target.
  const stale = await runHarness({ ...env, GRAPH_M7_LOGIN_CONFIRMED: firstQuestion.id });
  expect(stale.code).toBe(1);
  const recheck = await summary(workDir);
  expect(recheck.step).toBe('awaiting-human-check');
  expect(recheck.integrationSha).not.toBe(firstSha);
  const current = recheck.questions.filter(question => question.status === 'open' && question.kind === 'human_check');
  expect(current).toHaveLength(1);
  const currentQuestion = current[0]!;
  expect(currentQuestion.id).not.toBe(firstQuestion.id);
  expect(currentQuestion.data.commitSha).toBe(recheck.integrationSha);
  expect(recheck.answeredChecks.map(check => check.questionId)).toContain(firstQuestion.id);
  expect(provider.requests.length).toBe(10);

  // 6. Confirming the current question completes the task with bound evidence.
  const done = await runHarness({ ...env, GRAPH_M7_LOGIN_CONFIRMED: currentQuestion.id });
  expect(done.code).toBe(0);
  const completed = await summary(workDir);
  expect(completed.step).toBe('result');
  expect(completed.phase).toBe('completed');
  expect(completed.taskCount).toBe(1);
  expect(completed.acceptance).toEqual([
    { id: 'tests', description: 'The web tests pass', checkNode: 'check', valid: true, summary: expect.any(String), commitSha: completed.integrationSha },
    { id: 'human-login', description: 'User confirmed login in the isolated profile', checkNode: 'login', valid: true, summary: expect.any(String), commitSha: completed.integrationSha },
  ]);
  expect(completed.cost).toEqual({ unknown: true });
  expect(completed.costSource).toBe('model-rates-not-configured');
  expect((await readFile(join(project, 'test/web.test.js'), 'utf8'))).toContain('web works');
  expect((await readFile(join(project, 'revision-marker.txt'), 'utf8'))).toBe('moved\n');

  // 7. A repeated run is a no-op: same task, no new confirmations, no new model calls.
  const repeat = await runHarness({ ...env, GRAPH_M7_LOGIN_CONFIRMED: currentQuestion.id });
  expect(repeat.code).toBe(0);
  const repeated = await summary(workDir);
  expect(repeated.step).toBe('completed');
  expect(repeated.taskCount).toBe(1);
  expect(provider.requests.length).toBe(10);
  expect(JSON.stringify(repeated.answeredChecks)).toBe(JSON.stringify(completed.answeredChecks));
}, 240_000);

test('the harness can acknowledge a recorded reservation overrun without re-planning', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-m7-overrun-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const source = await fixtureRepo(parent);
  const workDir = join(parent, 'run');
  const provider = await openaiServer([
    { tools: [{ id: 'p1', name: 'propose_graph', arguments: JSON.stringify({ proposalJson: JSON.stringify(proposal), requestId: 'm7-plan' }) }], usage: { prompt_tokens: 2_100_000, completion_tokens: 5 } },
    { text: 'Proposed the Bilibili web graph.', usage: { prompt_tokens: 1_000, completion_tokens: 5 } },
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
  expect(proposed.questions.some(question => question.kind === 'reservation_exceeded' && question.status === 'open')).toBe(true);

  const acknowledged = await runHarness({ ...env, GRAPH_M7_ACKNOWLEDGE_OVERRUN: '1' });
  expect(acknowledged.code).toBe(1);
  const after = await summary(workDir);
  expect(after.step).toBe('awaiting-confirmation');
  expect(after.questions.some(question => question.kind === 'reservation_exceeded' && question.status === 'open')).toBe(false);
  expect(after.acceptedProposalVersion).toBeNull();
  expect(provider.requests.length).toBe(2);
}, 120_000);
