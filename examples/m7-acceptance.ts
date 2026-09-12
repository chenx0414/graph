import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../src/core/task-runtime.ts';
import type { ModelCost, ModelEntry } from '../src/catalog/models.ts';
import type { Proposal } from '../src/core/types.ts';
import { git } from '../src/git/git.ts';

/**
 * Real-model M7 acceptance harness (G17/G18).
 *
 * This is the run that A13 needs: a configured model proposes the graph from
 * the frozen requirement, implements the Bilibili web, runs the checks, gets an
 * independent review, and merges to the target branch. It is intentionally not
 * part of the automated suite because it requires a user-configured model and,
 * for the login acceptance item, a real Bilibili login.
 *
 * Runtime directory and state:
 *   - The default work directory is fixed (`../graph-m7-acceptance`), so a
 *     rerun resumes the same clone, state, and task. `GRAPH_M7_WORKDIR` (or the
 *     first positional argument) overrides it.
 *   - `<workdir>/run.json` persists the task id and every confirmation already
 *     recorded. `runtime.user.begin` is idempotent on the same directory, so a
 *     lost run.json still resumes the same task instead of creating a new one.
 *   - `GRAPH_M7_ACCEPT=<proposalVersion>` confirms exactly the proposal version
 *     printed by this run; a different version (including a stale `1`) is
 *     refused and the current version is printed again.
 *   - `GRAPH_M7_LOGIN_CONFIRMED=<questionId>` answers exactly one currently open
 *     human check. Checks raised for an older activation are resolved as
 *     superseded cleanup and are never accepted as confirmation. When the
 *     integration commit moved after a check was raised, confirming it only
 *     re-runs the check and a fresh question is printed.
 *
 * Required environment (one OpenAI-compatible endpoint, two distinct model ids
 * so the independent review never reuses the implementation model):
 *   GRAPH_M7_MODEL_ID / GRAPH_M7_MODEL_BASE_URL / GRAPH_M7_MODEL_API_KEY
 *   GRAPH_M7_REVIEW_MODEL_ID
 * Optional:
 *   GRAPH_M7_WORKDIR, GRAPH_M7_ACCEPT, GRAPH_M7_LOGIN_CONFIRMED
 *   GRAPH_M7_REPORT (default: <workdir>/acceptance-report.json)
 *   GRAPH_M7_MODEL_CONTEXT_WINDOW, GRAPH_M7_MODEL_MAX_TOKENS
 *   GRAPH_M7_MODEL_INPUT_COST, GRAPH_M7_MODEL_OUTPUT_COST,
 *   GRAPH_M7_MODEL_CACHE_READ_COST, GRAPH_M7_MODEL_CACHE_WRITE_COST
 *   (USD per million tokens; without them the report keeps `cost: unknown`)
 *   GRAPH_M7_RETRIEVAL_DOMAINS, GRAPH_M7_MCP_DOMAINS (comma-separated;
 *   without them no retrieval tool or remote MCP host is granted)
 *   GRAPH_M7_ACKNOWLEDGE_OVERRUN=1 records an explicit acknowledgement for
 *   every open reservation_exceeded question; the overrun stays in the report.
 *
 * Exit codes: 0 completed/no-op, 1 waiting for the next user confirmation or
 * host answer, 2 invalid configuration or unexpected failure.
 */
const request = '为本机 MediaBookmarks 增加 B站 Web：确认登录、采集、进度与失败原因、浏览收藏和笔记、导出 Markdown。';
const targetBranch = 'main';
const projectId = 'media-bookmarks';

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;
type Task = ReturnType<Runtime['user']['task']>;
type View = Awaited<ReturnType<Task['view']>>;
type Question = View['questions'][number];

interface RunState {
  version: 1;
  request: string;
  taskId: string;
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
    if (parsed.version !== 1 || !parsed.taskId) throw new Error(`Unsupported run state in ${path}`);
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

async function runSession(runtime: Runtime, task: Task, state: RunState, paths: HarnessPaths) {
  const evidence = (view: View) => view.proposal?.acceptance.map(item => {
    const matched = view.evidence.find(row => row.acceptanceId === item.id && row.valid);
    return {
      id: item.id, description: item.description, checkNode: item.checkNode, valid: Boolean(matched),
      ...(matched ? { summary: matched.summary, commitSha: matched.commitSha ?? null } : {}),
    };
  }) ?? [];
  const finish = async (view: View, detail: { step: string; proposal?: Proposal | null; note?: string; resume?: string }, code: number) => {
    const summary = {
      step: detail.step,
      taskId: view.id,
      workDir: paths.workDir,
      runFile: paths.runFile,
      reportPath: paths.reportPath,
      taskCount: (await runtime.user.list()).length,
      phase: view.phase,
      requirementVersion: view.requirementVersion,
      proposalVersion: view.proposalVersion,
      acceptedProposalVersion: view.acceptedProposalVersion,
      targetBranch: view.targetBranch,
      integrationSha: view.integrationSha,
      acceptance: evidence(view),
      proposal: detail.proposal ?? null,
      questions: view.questions,
      answeredChecks: state.answeredChecks,
      invocationCount: view.invocations.length,
      cost: view.cost,
      costSource: paths.rates ? 'configured-rates' : 'model-rates-not-configured',
      costRates: paths.rates ?? null,
      network: paths.network ?? null,
      ...(detail.note ? { note: detail.note } : {}),
      ...(detail.resume ? { resume: detail.resume } : {}),
    };
    await writeFile(paths.reportPath, `${JSON.stringify({ summary, view }, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    if (!paths.rates && view.cost && typeof view.cost === 'object' && !Array.isArray(view.cost) && (view.cost as { unknown?: boolean }).unknown) {
      console.log('Cost: unknown. Set GRAPH_M7_MODEL_INPUT_COST/GRAPH_M7_MODEL_OUTPUT_COST (plus cache rates) to estimate it.');
    } else if (paths.rates && view.cost && typeof view.cost === 'object' && !Array.isArray(view.cost) && (view.cost as { unknown?: boolean }).unknown) {
      console.log('Cost: unknown for at least one invocation; some provider responses lacked usage.');
    }
    return code;
  };

  let view = await task.view();
  const acknowledgeOverruns = async (current: View) => {
    if (process.env.GRAPH_M7_ACKNOWLEDGE_OVERRUN !== '1') return current;
    const overruns = current.questions.filter(question => question.status === 'open' && question.kind === 'reservation_exceeded');
    if (!overruns.length) return current;
    for (const question of overruns) {
      console.log(`Acknowledging recorded overrun on ${question.nodeId} (${question.id}).`);
      await task.answer(question.id, { type: 'acknowledge' }, `m7-overrun-${question.id}`);
    }
    return task.view();
  };
  view = await acknowledgeOverruns(view);
  if (view.phase === 'completed') return finish(view, { step: 'completed', resume: 'This run is already complete; nothing was rebuilt or reconfirmed.' }, 0);

  if (view.acceptedProposalVersion !== null && state.acceptedProposalVersion === null) {
    // A previous process may have crashed after confirmation but before saving.
    state.acceptedProposalVersion = view.acceptedProposalVersion;
    state.targetBranch = view.targetBranch;
    state.requirementVersion = view.requirementVersion;
    await saveState(paths.runFile, state);
  }
  if ((view.acceptedProposalVersion ?? null) !== (state.acceptedProposalVersion ?? null)) {
    return finish(view, { step: 'state-mismatch', note: 'The task and run.json disagree about the confirmed proposal; start a fresh GRAPH_M7_WORKDIR.' }, 1);
  }
  if (view.requirementVersion !== state.requirementVersion) {
    return finish(view, { step: 'requirement-changed', note: 'The requirement changed after confirmation; a new proposal and confirmation are required.' }, 1);
  }

  if (view.proposal === null) {
    await runtime.host.drive();
    view = await task.view();
  }
  if (view.proposal === null) {
    return finish(view, { step: 'awaiting-proposal', note: 'The master did not submit a proposal; inspect the open questions.', resume: `npm run accept:m7` }, 1);
  }

  if (view.acceptedProposalVersion === null) {
    console.log(`Proposal version ${view.proposalVersion} (requirement version ${view.requirementVersion}) needs explicit confirmation.`);
    console.log(`Review it, then rerun with: GRAPH_M7_ACCEPT=${view.proposalVersion}`);
    if (process.env.GRAPH_M7_ACCEPT?.trim() !== String(view.proposalVersion)) {
      return finish(view, {
        step: 'awaiting-confirmation', proposal: view.proposal,
        note: 'GRAPH_M7_ACCEPT must name this exact proposal version; a different version is never confirmed.',
        resume: `GRAPH_M7_ACCEPT=${view.proposalVersion} npm run accept:m7`,
      }, 1);
    }
    await task.accept({ proposalVersion: view.proposalVersion, targetBranch, requestId: `m7-accept-${view.proposalVersion}` });
    state.acceptedProposalVersion = view.proposalVersion;
    state.targetBranch = targetBranch;
    state.requirementVersion = view.requirementVersion;
    await saveState(paths.runFile, state);
    console.log(`Confirmed proposal version ${view.proposalVersion} on target branch ${targetBranch}.`);
  }

  await runtime.host.drive();
  view = await task.view();

  for (let round = 0; round < 20; round++) {
    const open = view.questions.filter(question => question.status === 'open');
    if (!open.length) break;
    const human = open.filter(question => question.kind === 'human_check');
    const others = open.filter(question => question.kind !== 'human_check');
    const activations = new Map(view.nodes.map(node => [node.id, node.activationId]));
    const superseded = human.filter(question => questionData(question).activationId !== activations.get(question.nodeId));
    for (const question of superseded) {
      // A check from an older activation cannot satisfy the current one; resolving
      // it is cleanup, not a confirmation of the current target.
      console.log(`Check ${question.nodeId} (${question.id}) was superseded by a later activation; clearing the stale record.`);
      await task.answer(question.id, { type: 'acknowledge' }, `m7-supersede-${question.id}`);
      state.answeredChecks.push({ questionId: question.id, nodeId: question.nodeId, activationId: questionData(question).activationId ?? null, commitSha: questionData(question).commitSha ?? null });
    }
    if (superseded.length) {
      await saveState(paths.runFile, state);
      await runtime.host.drive();
      view = await task.view();
      continue;
    }
    if (others.length) {
      const acknowledged = await acknowledgeOverruns(view);
      if (acknowledged !== view) { view = acknowledged; continue; }
      return finish(view, { step: 'questions', note: 'Non-human questions need an explicit host or user answer before this harness can continue.' }, 1);
    }
    const confirmed = process.env.GRAPH_M7_LOGIN_CONFIRMED?.trim();
    const target = human.find(question => question.id === confirmed);
    if (!target) {
      for (const question of human) {
        const data = questionData(question);
        console.log(`Check ${question.nodeId} needs the user: ${data.prompt ?? 'human check required'}`);
        console.log(`After performing it, rerun with: GRAPH_M7_LOGIN_CONFIRMED=${question.id}`);
      }
      return finish(view, {
        step: 'awaiting-human-check',
        note: 'Only the named open question is answered; an old id is never reused for a new check.',
        resume: human.map(question => `GRAPH_M7_LOGIN_CONFIRMED=${question.id}`).join(' | '),
      }, 1);
    }
    const data = questionData(target);
    if ((data.commitSha ?? null) !== (view.integrationSha ?? null)) {
      console.log(`Check ${target.id} was raised for ${data.commitSha ?? 'no commit'}, but the integration commit is now ${view.integrationSha ?? 'none'}.`);
      console.log('Confirming it only re-runs the check; a fresh question will be printed for the current target.');
    }
    console.log(`Answering check ${target.id} on ${target.nodeId}.`);
    await task.answer(target.id, { type: 'acknowledge' }, `m7-check-${target.id}`);
    state.answeredChecks.push({ questionId: target.id, nodeId: target.nodeId, activationId: data.activationId ?? null, commitSha: data.commitSha ?? null });
    await saveState(paths.runFile, state);
    await runtime.host.drive();
    view = await task.view();
  }

  const open = view.questions.filter(question => question.status === 'open');
  return finish(view, {
    step: 'result',
    ...(open.length ? { note: 'Questions are still open after the confirmation budget.' } : {}),
  }, view.phase === 'completed' && !open.length ? 0 : 1);
}

async function main() {
  const baseUrl = required('GRAPH_M7_MODEL_BASE_URL');
  const apiKey = required('GRAPH_M7_MODEL_API_KEY');
  const implementationId = required('GRAPH_M7_MODEL_ID');
  const reviewId = required('GRAPH_M7_REVIEW_MODEL_ID');
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
  // Program checks may resolve dependencies and run a local browser test from
  // host-selected paths; none of this comes from a worker or the proposal.
  const programReadPaths = (process.env.GRAPH_M7_PROGRAM_READ_PATHS ?? '').split(':').map(value => value.trim()).filter(Boolean);
  const programNodeModules = process.env.GRAPH_M7_PROGRAM_NODE_MODULES?.trim();
  const programEnv = process.env.GRAPH_M7_PROGRAM_ENV?.trim()
    ? JSON.parse(process.env.GRAPH_M7_PROGRAM_ENV) as Record<string, string>
    : undefined;
  const program = {
    ...(programReadPaths.length ? { readPaths: programReadPaths } : {}),
    ...(programNodeModules ? { nodeModulesPath: programNodeModules } : {}),
    ...(programEnv ? { env: programEnv } : {}),
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
    ...(Object.keys(program).length ? { program } : {}),
  });
  try {
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
    runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
    const previous = await loadState(paths.runFile);
    if (previous && previous.request !== request) throw new Error(`run.json in ${workDir} belongs to a different requirement; use a fresh GRAPH_M7_WORKDIR`);
    const { taskId } = await runtime.user.begin({ projectId, request, requestId: 'm7-begin' });
    if (previous && previous.taskId !== taskId) throw new Error(`run.json references task ${previous.taskId} but this state directory belongs to ${taskId}; use a fresh GRAPH_M7_WORKDIR`);
    const state: RunState = previous ?? {
      version: 1, request, taskId, requirementVersion: 1,
      acceptedProposalVersion: null, targetBranch: null, answeredChecks: [],
    };
    console.log(`Task: ${taskId}${previous ? ' (resumed)' : ''}`);
    if (!previous) await saveState(paths.runFile, state);
    return await runSession(runtime, runtime.user.task(taskId), state, paths);
  } finally {
    await runtime.close();
  }
}

main().then(code => process.exit(code ?? 0)).catch(error => { console.error(String(error)); process.exit(2); });
