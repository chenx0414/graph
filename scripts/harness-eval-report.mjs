// The real-model evaluation, as a step of the loop.
//
// The behaviour gate judges the harness with a scripted model: free, exact, and
// blind to how good the prompt is. It cannot answer the other question -
// "does a real model still do the work under this harness?" - because that
// needs a real model, a real budget and a real day.
//
// This runner does that part. It freezes the harness surface that actually
// runs, carries the frozen cases out under it one by one with the model the
// config names, and records the verdict of each case next to the surface it
// was judged on. So the next run can say "the cli case used to pass and does
// not any more", and the Agent can keep that as a lesson.
//
// It is on demand, not part of `node --run check`: a real model needs a
// credential and a budget, and a gate nobody can run is not a gate.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cases } from './harness-eval-cases.mjs';

const execute = promisify(execFile);
const repo = resolve(fileURLToPath(import.meta.url), '../..');

/** The ledger the verdicts are kept in, next to the harness they judge. */
const DEFAULT_LEDGER = join(homedir(), '.graph', 'harness-eval-verdicts.json');

/** The report the loop reads after a run. */
const DEFAULT_REPORT = join(homedir(), '.graph', 'harness-eval-report.json');

/**
 * The config that names the model. The one the app runs with is the one whose
 * credentials this machine has, so it is looked for before the repository's
 * own.
 */
function discoverConfig() {
  const candidates = [
    process.env.GRAPH_CONFIG_PATH,
    join(homedir(), 'Library', 'Application Support', 'Graph', 'graph.config.json'),
    join(repo, 'graph.config.json'),
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) ?? '';
}

function parseArguments(argv) {
  const options = {
    config: '',
    cases: [],
    surface: join(homedir(), '.graph'),
    ledger: DEFAULT_LEDGER,
    report: DEFAULT_REPORT,
    timeoutMs: 180000,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1] ?? '';
    if (flag === '--config') { options.config = value; index++; continue; }
    if (flag === '--surface') { options.surface = value; index++; continue; }
    if (flag === '--ledger') { options.ledger = value; index++; continue; }
    if (flag === '--report') { options.report = value; index++; continue; }
    if (flag === '--cases') { options.cases = value.split(',').map(name => name.trim()).filter(Boolean); index++; continue; }
    if (flag === '--timeout') { options.timeoutMs = Number(value); index++; continue; }
    if (flag === '--help' || flag === '-h') {
      process.stdout.write('Usage: node scripts/harness-eval-report.mjs --config <config.json> [--cases parser,cli] [--surface <graph home>] [--ledger <file>] [--report <file>]\n');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.config) options.config = discoverConfig();
  if (!options.config) throw new Error('A config is required: it names the model that carries the cases out');
  if (!existsSync(options.config)) throw new Error(`The config does not exist: ${options.config}`);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('The timeout must be a positive number of milliseconds');
  return options;
}

/** The ledger as it stands, or an empty one. */
async function readLedger(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { schemaVersion: 1, runs: [] };
  }
}

/**
 * The surface the cases were judged on. The snapshot manifest already carries
 * a digest of everything that was frozen, so the verdict is tied to the exact
 * harness that produced it.
 */
function surfaceFingerprint(manifest) {
  return createHash('sha256').update(String(manifest?.sha256 ?? '')).digest('hex');
}

/**
 * Freeze the surface the cases will run under. A frozen context is what makes
 * two runs comparable: the same prompts, the same recipes, the same
 * capabilities.
 */
async function freezeSurface(surface, root) {
  const snapshot = join(root, 'surface');
  await execute(process.execPath, ['scripts/harness-eval-context.mjs', surface, snapshot], { cwd: repo, timeout: 120000 });
  const manifest = JSON.parse(await readFile(join(snapshot, 'context.json'), 'utf8'));
  return { snapshot, manifest };
}

/** Carry one frozen case out under the frozen surface with the configured model. */
async function runCase(caseId, options, snapshot) {
  const started = Date.now();
  try {
    const { stdout } = await execute(process.execPath, ['scripts/harness-real-eval.mjs', options.config, caseId], {
      cwd: repo,
      timeout: options.timeoutMs + 180000,
      env: {
        ...process.env,
        GRAPH_EVAL_CONTEXT_SNAPSHOT: snapshot,
        GRAPH_EVAL_TIMEOUT_MS: String(options.timeoutMs),
      },
    });
    const report = JSON.parse(stdout);
    return {
      caseId,
      model: report.model ?? '',
      verdict: report.taskSuccess ? 'pass' : 'fail',
      verification: report.verification ?? '',
      elapsedMs: report.elapsedMs ?? Date.now() - started,
      cost: report.accounting?.summary?.costPerCompletedTask ?? null,
      tokens: report.task?.tokens ?? null,
    };
  } catch (error) {
    return {
      caseId,
      model: '',
      verdict: 'fail',
      verification: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
      cost: null,
      tokens: null,
    };
  }
}

/**
 * What changed since the last run of the same case: the case used to pass and
 * does not any more, or it did not pass and does now.
 */
function compare(previous, current) {
  if (!previous) return 'new';
  if (previous.verdict === current.verdict) return 'unchanged';
  return previous.verdict === 'pass' ? 'regressed' : 'improved';
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const caseIds = options.cases.length ? options.cases : Object.keys(cases);
  const root = await mkdtemp(join(tmpdir(), 'graph-harness-eval-'));
  try {
    const { snapshot, manifest } = await freezeSurface(options.surface, root);
    const ledger = await readLedger(options.ledger);
    const previous = ledger.runs?.[0]?.cases ?? {};
    const results = [];
    for (const caseId of caseIds) {
      const result = await runCase(caseId, options, snapshot);
      result.change = compare(previous[caseId], result);
      results.push(result);
      process.stdout.write(`${caseId}: ${result.verdict}${result.change === 'unchanged' ? '' : ` (${result.change})`}\n`);
    }
    const run = {
      surface: options.surface,
      surfaceFingerprint: surfaceFingerprint(manifest),
      model: results.find(result => result.model)?.model ?? '',
      recordedAt: new Date().toISOString(),
      cases: Object.fromEntries(results.map(result => [result.caseId, { verdict: result.verdict, verification: result.verification }])),
    };
    const report = { run, results };
    await mkdir(dirname(options.ledger), { recursive: true });
    await writeFile(options.ledger, `${JSON.stringify({ schemaVersion: 1, runs: [run, ...(ledger.runs ?? [])].slice(0, 20) }, null, 2)}\n`);
    await mkdir(dirname(options.report), { recursive: true });
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    const regressions = results.filter(result => result.change === 'regressed');
    const improvements = results.filter(result => result.change === 'improved');
    process.stdout.write(`\n${results.filter(result => result.verdict === 'pass').length}/${results.length} cases passed under ${options.surface}\n`);
    if (regressions.length) process.stdout.write(`regressed: ${regressions.map(result => result.caseId).join(', ')}\n`);
    if (improvements.length) process.stdout.write(`improved: ${improvements.map(result => result.caseId).join(', ')}\n`);
    process.stdout.write(`verdicts: ${options.ledger}\nreport: ${options.report}\n`);
    if (regressions.length) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
