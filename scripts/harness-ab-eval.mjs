import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {cases} from './harness-eval-cases.mjs';
import {launchCli} from '../tests/helpers/cli-daemon.ts';
const exec=promisify(execFile);

/**
 * The A/B of the harness changes: the same task, the same model, the same
 * starting point, two configurations.
 *
 * The daemon is the Go backend - the one the desktop application runs - so the
 * comparison is of the product and not of a developer path. The variants
 * alternate within every repetition, so a warm cache or a slow minute cannot
 * land on one side of the comparison.
 *
 * Usage:
 *   node scripts/harness-ab-eval.mjs /path/to/graph.config.json [case]
 *
 * The cases are the frozen task inputs of scripts/harness-eval-cases.mjs, plus
 * `big-output` here: the shared set does not force the agent to run the
 * checker, and an agent that edits the configuration without running it never
 * produces a large tool result at all.
 *
 * Environment:
 *   GRAPH_AB_REPEATS      repetitions per variant (default 5)
 *   GRAPH_AB_VARIANTS     comma separated variants (default default,reuse)
 *   GRAPH_AB_TURNS        follow-up turns of the same conversation (default 1)
 *   GRAPH_AB_FOLLOWUP     0 to run the task once and stop (default on)
 *   GRAPH_AB_KEEP         1 to keep the run's directory for inspection
 *   GRAPH_EVAL_TIMEOUT_MS the wall clock one turn may take (default 180000)
 *
 * The credential of the provider comes from the environment the configuration
 * names; this script never reads a key of its own.
 */

const VARIANTS = {
  default: { env: {} },
  reuse: { env: { GRAPH_REUSE_TASK_SETUP: '1', GRAPH_COMPACTION_CONTEXT_CEILING: '131072' } },
  ceiling: { env: { GRAPH_COMPACTION_CONTEXT_CEILING: '131072' } },
  setup: { env: { GRAPH_REUSE_TASK_SETUP: '1' } },
  // The ceiling at a level a one-shot task can reach: the mechanism is measured
  // on a short task instead of waiting for a session that grows for hours.
  'ceiling-low': { env: { GRAPH_REUSE_TASK_SETUP: '1', GRAPH_COMPACTION_CONTEXT_CEILING: '8192' } },
  // A ceiling a long session can reach: the context of a session that keeps
  // working passes a hundred thousand tokens long before the provider's window.
  'ceiling-32k': { env: { GRAPH_REUSE_TASK_SETUP: '1', GRAPH_COMPACTION_CONTEXT_CEILING: '32768' } },
  'setup-only': { env: { GRAPH_REUSE_TASK_SETUP: '1' } },
  // The seam off: the result is carried as the tool produced it, and the
  // kernel's own truncation cuts it.
  'no-seam': { env: { GRAPH_TOOL_RESULT_SEAM: '0' } },
  // The seam off and a ceiling: the context grows the way it grew before the
  // seam, and the ceiling is what keeps it from reaching the window.
  'no-seam-ceiling': { env: { GRAPH_TOOL_RESULT_SEAM: '0', GRAPH_COMPACTION_CONTEXT_CEILING: '32768' } },
};

if (process.argv.length < 3 || process.argv.length > 4) {
  console.error('Usage: node scripts/harness-ab-eval.mjs /path/to/graph.config.json [case]');
  process.exit(1);
}
const configPath = process.argv[2];
const caseId = process.argv[3] ?? 'parser';
// A case of its own: the checker prints five thousand lines, so the tool
// result is large enough for the seam to matter. The shared case set does not
// force the agent to run the checker, and an agent that edits the
// configuration without running it never produces a large result at all.
const LOCAL_CASES = {
  'big-output': {
    prompt: '运行 node check.mjs 并读完它的完整输出，然后修好配置让检查通过，不要改检查程序。',
    files: {
      'settings.json': '{"mode":"slow","label":"sample"}\n',
      'check.mjs': "import {readFileSync} from 'node:fs'; const config=JSON.parse(readFileSync('settings.json','utf8')); for(let i=0;i<5000;i++) console.log('diagnostic '+i); if(config.mode!=='fast'){console.error('mode must be fast');process.exit(1);} console.log('verified');\n",
    },
    verify: `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      assert.deepEqual(JSON.parse(readFileSync('settings.json','utf8')),{mode:'fast',label:'sample'});
      const result=spawnSync(process.execPath,['check.mjs'],{encoding:'utf8',timeout:3000});assert.equal(result.status,0);assert.ok(result.stdout.endsWith('verified\\n'));`,
    unchanged: ['check.mjs'],
  },
};

const scenario = LOCAL_CASES[caseId] ?? cases[caseId];
if (!scenario) throw new Error(`Unknown evaluation case: ${caseId}`);
const repeats = Number(process.env.GRAPH_AB_REPEATS ?? 5);
if (!Number.isSafeInteger(repeats) || repeats <= 0) throw new Error('Invalid GRAPH_AB_REPEATS');
const deadlineMs = Number(process.env.GRAPH_EVAL_TIMEOUT_MS ?? 180000);
if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('Invalid GRAPH_EVAL_TIMEOUT_MS');
const variantNames = (process.env.GRAPH_AB_VARIANTS ?? 'default,reuse').split(',').map(name => name.trim()).filter(Boolean);
for (const name of variantNames) if (!VARIANTS[name]) throw new Error(`Unknown variant: ${name}`);

const source = JSON.parse(await readFile(configPath, 'utf8'));
const model = source.models.entries[0];

// The follow-up is the second turn of the same conversation. It is what makes
// the setup reuse measurable: a one-shot task sends the task setup once, and a
// session only re-sends it from the second turn on.
const FOLLOWUPS = {
  parser: '再确认一下边界情况：空行和值里的等号都要按原样处理。',
  cli: '再用几个不同的 --count 值试一下，确认输出都对。',
  persistence: '再跑一遍，确认重启后计数接着走。',
  command: '再跑一次检查，确认这次真的通过了。',
  'big-output': '再跑一次检查，确认这次真的通过了。',
};
const withFollowUp = process.env.GRAPH_AB_FOLLOWUP !== '0';
// The number of follow-up turns of the same conversation. A long conversation is
// where the setup repeats and where the context grows: one turn is a task, many
// turns are a session.
// A master that is preparing or dispatching is still working: only a settled
// master ends the wait.
const SETTLED = ['succeeded', 'failed', 'blocked', 'interrupted', 'abandoned', 'waiting'];
const turns = Number(process.env.GRAPH_AB_TURNS ?? 1);
if (!Number.isSafeInteger(turns) || turns < 0) throw new Error('Invalid GRAPH_AB_TURNS');

async function run(variant, index) {
  const root = await mkdtemp(join(tmpdir(), `graph-ab-${variant}-`));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  for (const [path, content] of Object.entries(scenario.files ?? {})) await writeFile(join(project, path), content);
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div>AB</div>');
  const evaluationConfig = { ...source, projects: [{ id: 'p', root: project }] };
  const runConfig = join(root, 'config.json');
  await writeFile(runConfig, JSON.stringify(evaluationConfig), { mode: 0o600 });
  let daemon;
  const started = Date.now();
  try {
    daemon = await launchCli(root, { configPath: runConfig, env: VARIANTS[variant].env, extraArgs: ['--execute'] });
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: model.id, text: scenario.prompt, requestId: `ab-${variant}-${index}` }),
    });
    if (created.status !== 200) throw new Error(`The conversation was refused: ${created.status}`);
    const { conversationId } = await created.json();
    let status = 'unknown';
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      status = view.master?.status ?? 'unknown';
      if (SETTLED.includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // The follow-up turns of the same conversation.
    for (let turn = 0; turn < turns && withFollowUp && status === 'succeeded' && FOLLOWUPS[caseId]; turn += 1) {
      const follow = await daemon.request(`/api/conversations/${conversationId}/messages`, {
        method: 'POST', body: JSON.stringify({ text: FOLLOWUPS[caseId], requestId: `ab-${variant}-${index}-follow-${turn}` }),
      });
      if (follow.status !== 200) throw new Error(`The follow-up was refused: ${follow.status}`);
      const untilFollow = Date.now() + deadlineMs;
      while (Date.now() < untilFollow) {
        const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
        status = view.master?.status ?? 'unknown';
        if (SETTLED.includes(status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    const durationMs = Date.now() - started;
    await daemon.close();
    daemon = undefined;

    // The independent behaviour check: the case's own verifier, run outside the agent.
    let verified = false;
    let verification = '';
    if (scenario.verify) {
      // The module's base is the working directory, so the checker's own
      // relative imports read the files the agent wrote.
      try {
        await exec(process.execPath, ['--input-type=module', '-e', scenario.verify], { cwd: project, timeout: 30_000 });
        verified = true;
      } catch (error) {
        verification = String(error.stdout ?? error.message ?? '').slice(0, 400);
      }
    }
    if (scenario.unchanged) {
      for (const path of scenario.unchanged) {
        const expected = scenario.files[path];
        const actual = await readFile(join(project, path), 'utf8');
        if (actual !== expected) verified = false;
      }
    }

    // The cost of the run, read from the run's own ledger.
    const { stdout } = await exec(process.execPath, ['scripts/harness-cost.mjs', join(root, 'state', 'tasks.sqlite')], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    const task = report.tasks.find(entry => entry.id === report.summary.tasks ? undefined : undefined) ?? report.tasks[0];
    const summary = report.summary;
    return {
      variant, index, status, verified, durationMs,
      requests: summary.requests,
      tokens: summary.tokens,
      cost: summary.scenarioCost?.USD?.total ?? null,
      costByBillingType: summary.scenarioCost?.USD?.byBillingType ?? null,
      context: summary.contextPerRequest?.cacheRead ?? null,
      compactions: summary.compactions ?? null,
      tools: report.tools.map(tool => ({ tool: tool.tool, calls: tool.calls, errors: tool.errors })).filter(tool => tool.errors > 0),
      unknownCost: summary.unknownCost,
      verification,
    };
  } catch (error) {
    // The daemon's own words are the diagnosis of a daemon that died.
    if (daemon) console.error(`[ab] ${variant} #${index} failed: ${error?.message ?? error}\n${daemon.stderr ?? ''}`);
    throw error;
  } finally {
    await daemon?.close();
    if (process.env.GRAPH_AB_KEEP === '1') console.error(`[ab] kept ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

const runs = [];
for (let index = 0; index < repeats; index += 1) {
  // The variants alternate inside every repetition: a warm cache or a slow
  // minute lands on both sides of the comparison.
  const order = index % 2 === 0 ? variantNames : [...variantNames].reverse();
  for (const variant of order) {
    let result;
    try {
      result = await run(variant, index);
    } catch (error) {
      // A run that could not finish is a result: the machine was too loaded, or
      // the provider went away. It is recorded, not retried and not hidden.
      console.error(`[ab] ${variant} #${index} did not finish: ${error?.message ?? error}`);
      result = { variant, index, status: 'failed', verified: false, durationMs: 0, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, costByBillingType: null, context: null, compactions: null, tools: [], unknownCost: 0, verification: String(error?.message ?? error).slice(0, 300) };
    }
    runs.push(result);
    const tokens = result.tokens ?? {};
    console.log(`${variant.padEnd(8)} #${index} status=${result.status} verified=${result.verified} requests=${result.requests} ` +
      `input=${tokens.input ?? 0} output=${tokens.output ?? 0} cacheRead=${tokens.cacheRead ?? 0} cost=${result.cost === null ? 'null' : '$' + result.cost.toFixed(6)} ` +
      `meanPrefix=${result.context?.mean ?? 'null'} compactions=${result.compactions?.completed ?? 0}/${result.compactions?.failed ?? 0} ${result.durationMs}ms`);
  }
}

const summary = {};
for (const name of variantNames) {
  const own = runs.filter(run => run.variant === name);
  const succeeded = own.filter(run => run.verified);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  summary[name] = {
    runs: own.length,
    verified: succeeded.length,
    verifiedRate: own.length ? succeeded.length / own.length : null,
    meanCost: mean(own.map(run => run.cost ?? 0)),
    meanRequests: mean(own.map(run => run.requests ?? 0)),
    meanInput: mean(own.map(run => run.tokens?.input ?? 0)),
    meanOutput: mean(own.map(run => run.tokens?.output ?? 0)),
    meanCacheRead: mean(own.map(run => run.tokens?.cacheRead ?? 0)),
    meanContextTokens: mean(own.map(run => run.context?.mean ?? 0)),
    meanDurationMs: mean(own.map(run => run.durationMs ?? 0)),
    toolErrors: own.reduce((sum, run) => sum + run.tools.reduce((inner, tool) => inner + tool.errors, 0), 0),
    meanCompactions: mean(own.map(run => run.compactions?.completed ?? 0)),
    failedCompactions: own.reduce((sum, run) => sum + (run.compactions?.failed ?? 0), 0),
  };
}
console.log(JSON.stringify({ case: caseId, model: model.id, repeats, summary, runs }, null, 2));
