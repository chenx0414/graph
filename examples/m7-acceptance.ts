import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../src/core/task-runtime.ts';
import { git } from '../src/git/git.ts';
import type { ModelEntry } from '../src/catalog/models.ts';

/**
 * Real-model M7 acceptance harness (G17/G18).
 *
 * This is the run that A13 needs: a configured model proposes the graph from
 * the frozen requirement, implements the Bilibili web, runs the checks, gets an
 * independent review, and merges to the target branch. It is intentionally not
 * part of the automated suite because it requires a user-configured model and,
 * for the login acceptance item, a real Bilibili login.
 *
 * Required environment (one OpenAI-compatible endpoint, two distinct model ids
 * so the independent review never reuses the implementation model):
 *   GRAPH_M7_MODEL_ID / GRAPH_M7_MODEL_BASE_URL / GRAPH_M7_MODEL_API_KEY
 *   GRAPH_M7_REVIEW_MODEL_ID
 * Optional:
 *   GRAPH_M7_WORKDIR, GRAPH_M7_ACCEPT=1, GRAPH_M7_LOGIN_CONFIRMED=1
 *   GRAPH_M7_REPORT (default: <workdir>/acceptance-report.json)
 */
const request = '为本机 MediaBookmarks 增加 B站 Web：确认登录、采集、进度与失败原因、浏览收藏和笔记、导出 Markdown。';
const targetBranch = 'main';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error([
      `Missing ${name}. Provide an OpenAI-compatible model to run the real M7 acceptance:`,
      '  GRAPH_M7_MODEL_ID, GRAPH_M7_MODEL_BASE_URL, GRAPH_M7_MODEL_API_KEY,',
      '  GRAPH_M7_REVIEW_MODEL_ID (a different model id used for the independent review).',
      'Then run: npm run accept:m7',
      'The harness stops before user confirmation unless GRAPH_M7_ACCEPT=1,',
      'and stops at the Bilibili login check unless GRAPH_M7_LOGIN_CONFIRMED=1.',
    ].join('\n'));
  }
  return value;
}

function model(id: string, baseUrl: string, contextWindow: number, maxTokens: number): Model<'openai-completions'> {
  return {
    id, name: id, provider: 'graph-m7', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow, maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function main() {
  const baseUrl = required('GRAPH_M7_MODEL_BASE_URL');
  const apiKey = required('GRAPH_M7_MODEL_API_KEY');
  const implementationId = required('GRAPH_M7_MODEL_ID');
  const reviewId = required('GRAPH_M7_REVIEW_MODEL_ID');
  if (reviewId === implementationId) throw new Error('GRAPH_M7_REVIEW_MODEL_ID must differ from GRAPH_M7_MODEL_ID so the review is independent');
  const contextWindow = Number(process.env.GRAPH_M7_MODEL_CONTEXT_WINDOW ?? 200_000);
  const maxTokens = Number(process.env.GRAPH_M7_MODEL_MAX_TOKENS ?? 16_384);

  const workDir = resolve(process.env.GRAPH_M7_WORKDIR?.trim() || process.argv[2] || join(process.cwd(), '..', `graph-m7-acceptance-${Date.now()}`));
  await mkdir(workDir, { recursive: true });
  const source = process.env.GRAPH_MEDIABOOKMARKS_ROOT?.trim() || join(process.cwd(), '..', '12-MediaBookmarks');
  const project = join(workDir, 'project');
  if (!existsSync(join(project, '.git'))) {
    const clone = git(source, ['clone', '--no-hardlinks', '--single-branch', source, project]);
    if (clone.code !== 0) throw new Error(clone.stderr || 'git clone failed');
  }

  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: true, refreshOnCreate: false });
  const implementation = model(implementationId, baseUrl, contextWindow, maxTokens);
  const review = model(reviewId, baseUrl, contextWindow, Math.min(maxTokens, 8_192));
  modelRuntime.registerProvider('graph-m7', { baseUrl, api: 'openai-completions', apiKey, models: [implementation, review] });
  const entries: ModelEntry[] = [
    { id: implementationId, provider: 'graph-m7', grade: 'high', api: 'openai-completions', baseUrl, contextWindow, maxTokens },
    { id: reviewId, provider: 'graph-m7', grade: 'high', api: 'openai-completions', baseUrl, contextWindow, maxTokens: 8_192 },
  ];

  const runtime = await openTaskRuntime({
    stateDir: join(workDir, 'state'),
    projects: [{ id: 'media-bookmarks', root: project }],
    models: { entries, apiKey, modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: implementationId },
  });
  try {
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
    runtime.catalog.publishDefinition('reviewer', { recommendedGrade: 'high', review: true }, 'reviewer');
    const { taskId } = await runtime.user.begin({ projectId: 'media-bookmarks', request, requestId: 'm7-begin' });
    const task = runtime.user.task(taskId);
    await runtime.host.drive();
    let view = await task.view();
    if (!view.proposal) {
      console.log(JSON.stringify({ step: 'proposal', ok: false, taskId, view }, null, 2));
      return 1;
    }
    console.log(JSON.stringify({ step: 'proposal', ok: true, taskId, requirementVersion: view.requirementVersion, summary: view.proposal.summary, acceptance: view.proposal.acceptance.map(item => item.id) }, null, 2));
    if (process.env.GRAPH_M7_ACCEPT !== '1') {
      console.log('Stopping before user confirmation. Review the proposal, then rerun with GRAPH_M7_ACCEPT=1.');
      return 1;
    }
    await task.accept({ proposalVersion: view.proposalVersion, targetBranch, requestId: 'm7-accept' });
    await runtime.host.drive();
    view = await task.view();
    const login = view.questions.find(question => question.kind === 'human_check');
    if (login) {
      console.log(JSON.stringify({ step: 'human-login', taskId, question: login, integrationSha: view.integrationSha }, null, 2));
      if (process.env.GRAPH_M7_LOGIN_CONFIRMED !== '1') {
        console.log('Complete the Bilibili login in the project .browser-profile, then rerun with GRAPH_M7_LOGIN_CONFIRMED=1.');
        return 1;
      }
      await task.answer(login.id, { type: 'acknowledge' }, 'm7-login');
      await runtime.host.drive();
      view = await task.view();
    }
    const report = {
      step: 'result', taskId, phase: view.phase, targetBranch: view.targetBranch, integrationSha: view.integrationSha,
      acceptance: view.proposal?.acceptance.map(item => item.id) ?? [],
      evidence: view.evidence.filter(item => item.valid).map(item => ({ acceptanceId: item.acceptanceId, commitSha: item.commitSha, summary: item.summary })),
      questions: view.questions, invocations: view.invocations, cost: view.cost,
    };
    const reportPath = process.env.GRAPH_M7_REPORT?.trim() || join(workDir, 'acceptance-report.json');
    await writeFile(reportPath, `${JSON.stringify({ view, report }, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
    return view.phase === 'completed' ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

main().then(code => process.exit(code ?? 0)).catch(error => { console.error(String(error)); process.exit(2); });
