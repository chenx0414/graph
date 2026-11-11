// The harness behavior gate: when the harness changes, the frozen cases run
// again and their behavior is judged.
//
// The suite proves that the code still works. This proves that the agent can
// still do its work with the harness that is installed: every frozen case is
// carried out by a model that only acts when the harness told it how, and the
// case's own independent check decides whether the work came out right.
//
// The gate keeps a record of the harness surface it judged and of the verdict
// of every case, so a change that breaks a case says which case broke and what
// the harness no longer tells the agent.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { cases } from './harness-eval-cases.mjs';
import { behaviorCases } from './harness-behavior-cases.mjs';
import { behaviorLastWords, startBehaviorProvider } from './harness-behavior-model.mjs';

const execute = promisify(execFile);
const repo = resolve(fileURLToPath(import.meta.url), '../..');
// Where the judged surface and the case verdicts are recorded. The check
// pipeline keeps it in the repository; a test run points it somewhere else so
// it never dirties the working tree.
const statePath = process.env.GRAPH_HARNESS_GATE_STATE
  ? resolve(process.env.GRAPH_HARNESS_GATE_STATE)
  : join(repo, 'backend/internal/graph/testdata/harness-surface.json');
// The record is written only when someone asks for it. The gate runs inside
// every gate run, and a check that rewrites a tracked file makes the working
// tree dirty as a side effect of checking it - which the RSI guard rightly
// refuses. Recording stays a deliberate act: refresh the file, commit it.
const records = process.env.GRAPH_HARNESS_GATE_RECORD === '1' || Boolean(process.env.GRAPH_HARNESS_GATE_STATE);

/**
 * The files that make up the harness the product ships. A change in any of
 * them can change what the agent is told or what it may do, so the frozen
 * cases have to run again.
 */
const HARNESS_SURFACE_FILES = [
  'backend/internal/graph/runtime_agent_context.go',
  'backend/internal/graph/runtime_agent_tool_definitions.go',
  'backend/internal/graph/runtime_agent_tools.go',
  'backend/internal/graph/runtime_pi_native_tools.go',
  'backend/internal/graph/runtime_pig_native_tools.go',
  'scripts/harness-eval-cases.mjs',
  'scripts/harness-real-eval.mjs',
  'scripts/harness-behavior-cases.mjs',
  'scripts/harness-behavior-model.mjs',
  'scripts/harness-behavior-gate.mjs',
];

/** The digest of one file, or an empty string when it is not there. */
async function digestOf(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return '';
  }
}

/** The digest of every file that makes up the shipped harness. */
async function shippedSurface() {
  const surface = {};
  for (const file of HARNESS_SURFACE_FILES) surface[file] = await digestOf(join(repo, file));
  return surface;
}

/**
 * The prompt library the developer actually runs with. It is not in the
 * repository, so the gate reports it instead of judging it - a snapshot says
 * which context to judge.
 */
async function liveSurface() {
  const home = process.env.HOME ?? '';
  const root = join(home, '.graph');
  const files = {};
  const walk = async (path) => {
    let entries = [];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files[relative(root, child)] = await digestOf(child);
    }
  };
  await walk(join(root, 'prompts'));
  const recipes = join(root, 'agent-combinations.json');
  if (await digestOf(recipes)) files['agent-combinations.json'] = await digestOf(recipes);
  return files;
}

/** The tool calls of one run, in the order they happened. */
function toolCalls(root) {
  const database = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    return database.prepare('SELECT tool, is_error FROM tool_calls ORDER BY id').all();
  } finally {
    database.close();
  }
}

/**
 * What the run showed about the harness: the tools the agent used, and the
 * cases where it did not use them the way the case needs.
 */
function judgeDiscipline(discipline, calls) {
  const names = calls.map((call) => call.tool);
  const problems = [];
  if (names.join(',') !== discipline.expected.join(',')) {
    problems.push(`the agent used ${names.join(' → ') || 'no tool at all'}, the case needs ${discipline.expected.join(' → ')}`);
  }
  for (const tool of discipline.forbidden ?? []) {
    if (names.includes(tool)) problems.push(`the agent used ${tool}, which the harness reserves for complete rewrites`);
  }
  if (calls.some((call) => call.is_error)) problems.push('a tool call failed');
  return problems;
}

/** One frozen case, carried out against the harness that is installed. */
async function runCase(caseId) {
  const script = behaviorCases[caseId];
  const provider = await startBehaviorProvider(script);
  const root = await mkdtemp(join(tmpdir(), `graph-harness-gate-${caseId}-`));
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [],
    credentials: { local: { secretRef: 'GRAPH_EVAL_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 256,
      credentialId: 'local', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  }));
  const snapshot = process.env.GRAPH_HARNESS_GATE_SNAPSHOT ?? '';
  try {
    const { stdout } = await execute(process.execPath, ['scripts/harness-real-eval.mjs', configPath, caseId], {
      cwd: repo,
      timeout: 180000,
      env: { ...process.env, HOME: root, GRAPH_EVAL_LOCAL_KEY: 'gate-key', GRAPH_EVAL_TIMEOUT_MS: '30000',
        ...(snapshot ? { GRAPH_EVAL_CONTEXT_SNAPSHOT: snapshot } : {}) },
    });
    const report = JSON.parse(stdout);
    const calls = toolCalls(report.root);
    const problems = judgeDiscipline(script, calls);
    if (!report.taskSuccess) problems.push(report.verification ?? 'the case did not complete');
    if (report.cleanupIncomplete) problems.push('the run did not close its ledger');
    const words = behaviorLastWords(provider.answers);
    if (problems.length && words) problems.push(`the agent said: ${words}`);
    return { verdict: problems.length ? 'fail' : 'pass', problems, elapsedMs: report.elapsedMs, calls: calls.map((call) => call.tool) };
  } catch (error) {
    return { verdict: 'fail', problems: [`the case could not run: ${error instanceof Error ? error.message : String(error)}`], elapsedMs: 0, calls: [] };
  } finally {
    await provider.close();
  }
}

/** The recorded state of the gate, or an empty one. */
async function readState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return { schemaVersion: 1, cases: {}, surface: {} };
  }
}

/** Which files of the harness surface changed since the last judged run. */
function surfaceChanges(recorded, current) {
  const changed = [];
  for (const [file, digest] of Object.entries(current)) {
    if (recorded[file] !== digest) changed.push(file);
  }
  for (const file of Object.keys(recorded ?? {})) {
    if (!(file in current)) changed.push(`${file} (removed)`);
  }
  return changed;
}

async function main() {
  const state = await readState();
  const surface = await shippedSurface();
  const changed = surfaceChanges(state.surface ?? {}, surface);
  const live = await liveSurface();
  const results = {};
  const failures = [];
  for (const caseId of Object.keys(cases)) {
    if (!behaviorCases[caseId]) {
      failures.push(`${caseId}: the frozen case has no scripted solution, so the gate cannot carry it out`);
      results[caseId] = 'fail';
      continue;
    }
    const result = await runCase(caseId);
    results[caseId] = result.verdict;
    const before = state.cases?.[caseId];
    if (result.verdict === 'fail') {
      const note = before === 'pass' ? 'regressed' : 'failed';
      failures.push(`${caseId}: ${note} - ${result.problems.join('; ')}`);
    }
    process.stdout.write(`${caseId}: ${result.verdict}${result.verdict === 'pass' ? '' : ` - ${result.problems.join('; ')}`}\n`);
  }
  if (changed.length) process.stdout.write(`harness surface changed since the last judged run:\n${changed.map((file) => `  ${file}`).join('\n')}\n`);
  if (Object.keys(live).length) {
    process.stdout.write(`live prompt library: ${Object.keys(live).length} file(s), judged surface: ${snapshotLabel()}\n`);
  }
  if (failures.length) {
    process.stdout.write(`\nharness behavior gate failed:\n${failures.map((line) => `  ${line}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const verdicts = Object.fromEntries(Object.entries(results));
  const unchanged = JSON.stringify(state.cases ?? {}) === JSON.stringify(verdicts)
    && JSON.stringify(state.surface ?? {}) === JSON.stringify(surface);
  if (!unchanged) {
    if (!records) {
      process.stdout.write('the judged state moved, and was not recorded (a check must not rewrite a tracked file)\n');
      process.stdout.write('record it deliberately: GRAPH_HARNESS_GATE_RECORD=1 node --run check:harness\n');
    } else {
      await writeFile(statePath, `${JSON.stringify({ schemaVersion: 1, cases: verdicts, surface, updatedAt: new Date().toISOString() }, null, 2)}\n`);
      process.stdout.write('recorded the judged harness surface and the case verdicts\n');
    }
  } else {
    process.stdout.write('the harness surface and every case are unchanged\n');
  }
  process.stdout.write('harness behavior gate passed\n');
}

/** Which context the gate judged. */
function snapshotLabel() {
  const snapshot = process.env.GRAPH_HARNESS_GATE_SNAPSHOT ?? '';
  return snapshot ? `the snapshot ${snapshot}` : 'the shipped defaults';
}

await main();
