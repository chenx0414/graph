import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../src/core/task-runtime.ts';
import type { ModelCost, ModelEntry } from '../src/catalog/models.ts';
import type { GraphAcceptance } from '../src/core/graph-acceptance.ts';
import { git } from '../src/git/git.ts';

/**
 * Native real-model M7 acceptance harness. Requires user-configured providers;
 * automated tests supply local HTTP providers and disposable Git repositories.
 *
 * GRAPH_M7_WORKDIR contains the clone, runtime state and run.json (version 2).
 * One long-lived conversation owns one separately confirmed native graph.
 * Reruns recover confirmation from SQLite if saving run.json was interrupted.
 * Legacy version-1 runs are rejected; use a fresh directory for the new kernel.
 *
 * Required: GRAPH_M7_MODEL_ID, GRAPH_M7_MODEL_BASE_URL, GRAPH_M7_MODEL_API_KEY,
 * GRAPH_M7_REVIEW_MODEL_ID (a different model). GRAPH_M7_ACCEPT confirms exactly
 * the printed draft version. Main receives graph_ready and explicitly delivers
 * named inputs, observes results and requests graph completion.
 * GRAPH_M7_LOGIN_CONFIRMED answers exactly one current human question for the
 * current integration commit. Superseded questions never count as approval.
 *
 * Optional: GRAPH_M7_REPORT, GRAPH_M7_MODEL_CONTEXT_WINDOW,
 * GRAPH_M7_MODEL_MAX_TOKENS, GRAPH_M7_MODEL_{INPUT,OUTPUT,CACHE_READ,CACHE_WRITE}_COST,
 * GRAPH_M7_RETRIEVAL_DOMAINS, GRAPH_M7_MCP_DOMAINS, GRAPH_M7_ACKNOWLEDGE_OVERRUN.
 * Native unknown provider usage must be reconciled with actual counts through
 * graph_control; there is no proof-only unknown-usage acknowledgement flag.
 * Exit: 0 completed/no-op, 1 waiting for input or main intervention, 2 failure.
 */
const requirement = '在现有本机 B站 Web 应用中修复导出失败反馈，并重跑既有验收检查：导出接口返回非 2xx（含 HTTP 500 与网络拒绝）时，页面调用的 API 必须保留并传播服务端错误原因，导出区域显示失败原因并允许重试，不得显示空成功汇总；补充真实页面的 HTTP 500 与网络拒绝端到端回归 test/e2e/bilibili-web-export-error.e2e.test.js；重新绑定登录确认、采集进度与失败原因、收藏与笔记浏览、导出 Markdown 的测试证据。';
const targetBranch = 'main';
const projectId = 'media-bookmarks';

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;
type Task = ReturnType<Runtime['user']['task']>;
type View = Awaited<ReturnType<Task['view']>>;
type Question = View['questions'][number];

interface RunState {
  version: 2;
  request: string;
  conversationId: string;
  taskId: string;
  graphId: string | null;
  requirementVersion: number;
  acceptedProposalVersion: number | null;
  targetBranch: string | null;
  answeredChecks: { questionId: string; nodeId: string; activationId: string | null; commitSha: string | null }[];
}

interface HarnessPaths {
  workDir: string;
  runFile: string;
  reportPath: string;
  rates?: ModelCost;
  network?: { retrievalDomains?: string[]; mcpDomains?: string[] };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error([
      `Missing ${name}. Provide an OpenAI-compatible model to run the real M7 acceptance:`,
      '  GRAPH_M7_MODEL_ID, GRAPH_M7_MODEL_BASE_URL, GRAPH_M7_MODEL_API_KEY,',
      '  GRAPH_M7_REVIEW_MODEL_ID (a different model id used for the independent review).',
      'Then run: npm run accept:m7',
      'The harness stops before user confirmation unless GRAPH_M7_ACCEPT=<proposalVersion>,',
      'and stops at each open human check unless GRAPH_M7_LOGIN_CONFIRMED=<questionId>.',
    ].join('\n'));
  }
  return value;
}

function costRates(): ModelCost | undefined {
  const read = (name: string) => process.env[name]?.trim();
  const input = read('GRAPH_M7_MODEL_INPUT_COST');
  const output = read('GRAPH_M7_MODEL_OUTPUT_COST');
  if (input === undefined && output === undefined) return undefined;
  const value = (raw: string | undefined, name: string) => {
    if (raw === undefined || raw === '') return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a nonnegative USD-per-million-token rate`);
    return parsed;
  };
  return {
    input: value(input, 'GRAPH_M7_MODEL_INPUT_COST'),
    output: value(output, 'GRAPH_M7_MODEL_OUTPUT_COST'),
    cacheRead: value(read('GRAPH_M7_MODEL_CACHE_READ_COST'), 'GRAPH_M7_MODEL_CACHE_READ_COST'),
    cacheWrite: value(read('GRAPH_M7_MODEL_CACHE_WRITE_COST'), 'GRAPH_M7_MODEL_CACHE_WRITE_COST'),
  };
}

function model(id: string, baseUrl: string, contextWindow: number, maxTokens: number, cost?: ModelCost): Model<'openai-completions'> {
  return {
    id, name: id, provider: 'graph-m7', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow, maxTokens,
    cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function loadState(path: string): Promise<RunState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as RunState;
    if (parsed.version !== 2 || !parsed.taskId || !parsed.conversationId) throw new Error(`Unsupported legacy run state in ${path}; use a fresh GRAPH_M7_WORKDIR for the native graph kernel`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveState(path: string, state: RunState) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

function questionData(question: Question) {
  return question.data as { activationId?: string; commitSha?: string | null; prompt?: string };
}

async function runSession(runtime: Runtime, state: RunState, paths: HarnessPaths) {
  const owner = runtime.supervisor(state.taskId);
  const anchor = runtime.user.task(state.taskId);
  const acknowledgeOverruns = async () => {
    if (process.env.GRAPH_M7_ACKNOWLEDGE_OVERRUN !== '1') return;
    for (const question of (await anchor.view()).questions.filter(item => item.status === 'open' && item.kind === 'reservation_exceeded')) {
      await anchor.answer(question.id, { type: 'acknowledge' }, `m7-overrun-${question.id}`);
    }
  };
  await acknowledgeOverruns();
  const finish = async (step: string, code: number, note?: string) => {
    const conversation = await runtime.conversations.view(state.conversationId);
    const view = await runtime.user.task(state.graphId ?? state.taskId).view();
    const assessment = state.graphId ? await owner.graphInspect({ graphId: state.graphId, query: 'acceptance' }) as GraphAcceptance : null;
    const summary = {
      step, conversationId: state.conversationId, mainTaskId: state.taskId, taskId: state.graphId ?? state.taskId, graphId: state.graphId,
      workDir: paths.workDir, runFile: paths.runFile, reportPath: paths.reportPath,
      taskCount: conversation.tasks.length, phase: view.phase, requirementVersion: state.requirementVersion,
      proposalVersion: state.acceptedProposalVersion ?? conversation.proposal?.version ?? 0,
      acceptedProposalVersion: state.acceptedProposalVersion, targetBranch: state.targetBranch,
      integrationSha: view.integrationSha, acceptance: assessment?.items ?? [], proposal: conversation.proposal?.spec ?? null,
      questions: view.questions, mainQuestions: (await anchor.view()).questions, answeredChecks: state.answeredChecks,
      invocationCount: view.invocations.length, cost: conversation.cost,
      costSource: paths.rates ? 'configured-rates-with-unpriced-native-calls' : 'model-rates-not-configured',
      costRates: paths.rates ?? null, network: paths.network ?? null,
      ...(note ? { note } : {}),
      resume: step === 'awaiting-confirmation' ? `GRAPH_M7_ACCEPT=${conversation.proposal?.version} npm run accept:m7`
        : step === 'awaiting-human-check' ? view.questions.filter(q => q.status === 'open' && q.kind === 'human_check').map(q => `GRAPH_M7_LOGIN_CONFIRMED=${q.id}`).join(' | ') : 'npm run accept:m7',
    };
    await writeFile(paths.reportPath, `${JSON.stringify({ summary, view, conversation, assessment }, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return code;
  };
  // Confirmation is authoritative in SQLite; recover a receipt saved before run.json.
  let conversation = await runtime.conversations.view(state.conversationId);
  const accepted = conversation.accepted;
  if (accepted.length > 1) return finish('state-mismatch', 1, 'This harness owns one confirmed graph; inspect additional confirmations separately.');
  if (accepted.length) {
    const receipt = accepted[0]!;
    if (state.graphId && state.graphId !== receipt.taskId) return finish('state-mismatch', 1, 'run.json and the confirmed graph disagree.');
    state.graphId = receipt.taskId; state.acceptedProposalVersion = receipt.proposalVersion; state.targetBranch = receipt.targetBranch;
    await saveState(paths.runFile, state);
  }
  if (state.graphId && (await runtime.user.task(state.graphId).view()).phase === 'completed') return finish('completed', 0);
  if (!state.graphId) {
    if (!conversation.proposal) { await runtime.host.drive(); conversation = await runtime.conversations.view(state.conversationId); }
    const draft = conversation.proposal;
    if (!draft) return finish('awaiting-proposal', 1, 'Main has not submitted a draft.');
    if (!draft.spec.definition) return finish('invalid-draft', 1, 'M7 requires a native schemaVersion:2 definition.');
    if (process.env.GRAPH_M7_ACCEPT?.trim() !== String(draft.version)) return finish('awaiting-confirmation', 1, 'Only the exact current proposal version can be confirmed.');
    const receipt = await runtime.conversations.confirm(state.conversationId, { proposalVersion: draft.version, targetBranch, requestId: `m7-accept-${draft.version}` });
    state.graphId = receipt.taskId; state.acceptedProposalVersion = draft.version; state.targetBranch = targetBranch; state.requirementVersion = draft.requirementVersion;
    await saveState(paths.runFile, state);
  }
  // Main receives graph_ready and starts named inputs; the harness never guesses roots.
  await runtime.host.drive();
  const task = runtime.user.task(state.graphId);
  let view = await task.view();
  if (view.phase === 'completed') return finish('result', 0);
  const human = view.questions.filter(q => q.status === 'open' && q.kind === 'human_check');
  const selected = human.find(q => q.id === process.env.GRAPH_M7_LOGIN_CONFIRMED?.trim());
  if (selected && (questionData(selected).commitSha ?? null) === (view.integrationSha ?? null)) {
    await task.answer(selected.id, { type: 'acknowledge' }, `m7-check-${selected.id}`);
    state.answeredChecks.push({ questionId: selected.id, nodeId: selected.nodeId, activationId: null, commitSha: questionData(selected).commitSha ?? null });
    await saveState(paths.runFile, state);
    await runtime.host.drive(); view = await task.view();
    if (view.phase === 'completed') return finish('result', 0);
  }
  if (view.questions.some(q => q.status === 'open' && q.kind === 'human_check')) return finish('awaiting-human-check', 1, 'Confirm only the current question for the current commit.');
  if (view.questions.some(q => q.status === 'open')) return finish('questions', 1, 'Main must resolve runtime issues; unknown usage requires actual call usage, never a proof-only waiver.');
  return finish('awaiting-work', 1, 'The graph is idle or blocked; main must explicitly deliver input or request completion.');
}

async function main() {
  const baseUrl = required('GRAPH_M7_MODEL_BASE_URL');
  const apiKey = required('GRAPH_M7_MODEL_API_KEY');
  const implementationId = required('GRAPH_M7_MODEL_ID');
  const reviewId = required('GRAPH_M7_REVIEW_MODEL_ID');
  const request = `${requirement}模型分配：work 使用 ${implementationId}，review 使用 ${reviewId}。`;
  if (reviewId === implementationId) throw new Error('GRAPH_M7_REVIEW_MODEL_ID must differ from GRAPH_M7_MODEL_ID so the review is independent');
  const rates = costRates();
  const contextWindow = Number(process.env.GRAPH_M7_MODEL_CONTEXT_WINDOW ?? 200_000);
  const maxTokens = Number(process.env.GRAPH_M7_MODEL_MAX_TOKENS ?? 16_384);

  const workDir = resolve(process.env.GRAPH_M7_WORKDIR?.trim() || process.argv[2] || join(process.cwd(), '..', 'graph-m7-acceptance'));
  const domainList = (name: string) => (process.env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const retrievalDomains = domainList('GRAPH_M7_RETRIEVAL_DOMAINS');
  const mcpDomains = domainList('GRAPH_M7_MCP_DOMAINS');
  const network = {
    ...(retrievalDomains.length ? { retrievalDomains } : {}),
    ...(mcpDomains.length ? { mcpDomains } : {}),
  };
  const paths: HarnessPaths = {
    workDir,
    runFile: join(workDir, 'run.json'),
    reportPath: process.env.GRAPH_M7_REPORT?.trim() || join(workDir, 'acceptance-report.json'),
    ...(rates ? { rates } : {}),
    ...(retrievalDomains.length || mcpDomains.length ? { network } : {}),
  };
  await mkdir(workDir, { recursive: true });
  console.log(`Run directory: ${workDir}`);
  const source = process.env.GRAPH_MEDIABOOKMARKS_ROOT?.trim() || join(process.cwd(), '..', '12-MediaBookmarks');
  const project = join(workDir, 'project');
  if (!existsSync(join(project, '.git'))) {
    const clone = git(source, ['clone', '--no-hardlinks', '--single-branch', source, project]);
    if (clone.code !== 0) throw new Error(clone.stderr || 'git clone failed');
  }

  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: true, refreshOnCreate: false });
  const implementation = model(implementationId, baseUrl, contextWindow, maxTokens, rates);
  const review = model(reviewId, baseUrl, contextWindow, Math.min(maxTokens, 8_192), rates);
  modelRuntime.registerProvider('graph-m7', { baseUrl, api: 'openai-completions', apiKey, models: [implementation, review] });
  const entries: ModelEntry[] = [
    { id: implementationId, provider: 'graph-m7', grade: 'high', api: 'openai-completions', baseUrl, contextWindow, maxTokens, ...(rates ? { cost: rates } : {}) },
    { id: reviewId, provider: 'graph-m7', grade: 'high', api: 'openai-completions', baseUrl, contextWindow, maxTokens: 8_192, ...(rates ? { cost: rates } : {}) },
  ];

  const runtime = await openTaskRuntime({
    stateDir: join(workDir, 'state'),
    projects: [{ id: projectId, root: project }],
    models: { entries, apiKey, modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: implementationId },
    ...(retrievalDomains.length || mcpDomains.length ? { network } : {}),
  });
  try {
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
    runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
    const previous = await loadState(paths.runFile);
    if (previous && previous.request !== request) throw new Error(`run.json in ${workDir} belongs to a different requirement; use a fresh GRAPH_M7_WORKDIR`);
    const { conversationId, taskId } = await runtime.conversations.create({ projectId, text: request, requestId: 'm7-conversation' });
    if (previous && (previous.taskId !== taskId || previous.conversationId !== conversationId)) throw new Error('run.json references another conversation; use a fresh GRAPH_M7_WORKDIR');
    const state: RunState = previous ?? { version: 2, request, conversationId, taskId, graphId: null,
      requirementVersion: 1, acceptedProposalVersion: null, targetBranch: null, answeredChecks: [] };
    if (!previous) await saveState(paths.runFile, state);
    return await runSession(runtime, state, paths);
  } finally {
    await runtime.close();
  }
}

main().then(code => process.exit(code ?? 0)).catch(error => { console.error(String(error)); process.exit(2); });
