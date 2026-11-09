#!/usr/bin/env node
// The suite always runs in full; a failure only blocks the gate when its file is
// not quarantined, and every quarantined failure is printed with its reason. A
// silent skip would be indistinguishable from a pass, so nothing here is silent.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const reportPath = join(root, 'tests/.suite-report.json');
// Kept beside the report and ignored by git: a review ledger of quarantined
// files that travels with the checkout but never rides along in a commit.
const historyPath = join(root, 'tests/.quarantine-history.json');

/**
 * Can this machine launch the browser the m8 layer needs?
 *
 * The layer drives a real Chromium, so an environment without window services
 * fails every one of its files with "Process failed to launch!". That is an
 * unavailable environment, not a regression, and a gate that calls it a
 * regression teaches people to ignore the gate. The probe is the same call the
 * tests make, so a skip is based on the real capability and not on a guess
 * about which machine we are on.
 */
function browserLaunches() {
  const probe = spawnSync(process.execPath, [
    '-e', `
      const { chromium } = require('playwright');
      chromium.launch({ headless: true })
        .then(async browser => { await browser.close(); process.stdout.write('ok'); })
        .catch(error => { process.stdout.write(String(error).split('\\n')[0]); process.exitCode = 1; });
    `,
  ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  return probe.status === 0 ? undefined : (probe.stdout || probe.stderr || 'launch failed').trim();
}

/**
 * Can this executor nest the seatbelt profile Graph's own bash tool applies?
 *
 * The deferred-tool cases run real commands through the daemon's bash tool, and
 * that tool wraps every command in /usr/bin/sandbox-exec. An executor that is
 * itself already seatbelted refuses the nest ("sandbox_apply: Operation not
 * permitted"), so the command exits 71 before it does anything: an unavailable
 * capability, not a regression. The probe is the same call, so the skip is a
 * measurement.
 */
function sandboxNests() {
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 20_000 });
  if (probe.status === 0) return undefined;
  return (probe.stderr || probe.stdout || 'sandbox-exec refused').trim().split('\n')[0];
}

const requested = process.argv.slice(2);
const requestedExcludes = requested.filter(argument => argument.startsWith('--exclude'));
const forced = process.env.GRAPH_BROWSER_LAYER;

/**
 * Layers of the suite that need a capability the machine may not have.
 *
 * A layer is a named capability plus the files that need it, and it is skipped
 * only when the probe proves the capability is unavailable. The alternative is
 * what this gate used to do: call every one of those files a regression because
 * a browser could not start, until nobody trusted the red.
 */
const layers = JSON.parse(readFileSync(join(root, 'tests/env-layers.json'), 'utf8')).layers;
function dockerDaemon() {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
  if (probe.status === 0) return undefined;
  return (probe.stderr || probe.stdout || 'docker refused').trim().split('\n')[0];
}

const probes = { chromium: browserLaunches, 'nested-sandbox': sandboxNests, 'docker-daemon': dockerDaemon };
const skippedLayers = [];
const layerExcludes = [];
for (const layer of layers) {
  const covered = layer.files.every(glob => requestedExcludes.some(argument => argument.includes(glob.replace('**', ''))));
  if (covered) continue;
  if (forced === 'skip') {
    skippedLayers.push({ ...layer, reason: 'GRAPH_BROWSER_LAYER=skip' });
    layerExcludes.push(...layer.files);
    continue;
  }
  if (forced === 'require') continue;
  const probe = probes[layer.probe];
  const reason = probe ? probe() : `no probe named ${layer.probe}`;
  if (reason) {
    skippedLayers.push({ ...layer, reason });
    layerExcludes.push(...layer.files);
  }
}
for (const layer of skippedLayers) {
  console.log(`check:tests: layer "${layer.capability}" skipped (${layer.files.length} entr(ies)) - ${layer.reason}`);
}
if (skippedLayers.length) {
  console.log('check:tests: skipped layers are unverified here; the host gate runs them where the capability exists, or set GRAPH_BROWSER_LAYER=require to demand them');
}
// The baseline check counts what ran, so it has to know what was deliberately
// left out; otherwise a skipped layer reads as deleted tests. Written on every
// run, including an empty one, so a stale file cannot hide a real shrink.
writeFileSync(
  join(root, 'tests/.suite-layers.json'),
  `${JSON.stringify({ layers: skippedLayers.map(layer => ({ capability: layer.capability, reason: layer.reason, files: layer.files })) }, null, 2)}\n`,
);

const run = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run',
  // bail=1 would stop the suite at the first failure, which makes a quarantined
  // failure look like a shrunk suite to the baseline check and hides whatever
  // else would have failed. The gate decides from a complete report.
  '--bail=0',
  // The caller decides the tier (check:affected forwards an --exclude); the
  // quarantine decision stays here so both tiers excuse the same files.
  ...requested,
  ...layerExcludes.flatMap(glob => ['--exclude', glob]),
  '--reporter=default', '--reporter=json', '--outputFile=tests/.suite-report.json',
], { stdio: 'inherit', cwd: root });

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch {
  console.error('check:tests: vitest wrote no report — the run itself failed');
  process.exit(run.status ?? 1);
}

const relative = name => (name.startsWith(root) ? name.slice(root.length + 1) : name);
const quarantined = new Map();
for (const entry of JSON.parse(readFileSync(join(root, 'tests/quarantine.json'), 'utf8')).files) quarantined.set(entry.path, entry.reason);

const ran = new Set(report.testResults.map(result => relative(result.name)));
const failed = report.testResults.filter(result => result.status === 'failed').map(result => relative(result.name));
const excused = failed.filter(file => quarantined.has(file));
const blocking = failed.filter(file => !quarantined.has(file));
const stale = [...quarantined.keys()].filter(file => !ran.has(file));

/** The failing test names and their first line of failure, for a report someone can act on. */
function firstFailures(result) {
  return (result.assertionResults ?? [])
    .filter(item => item.status === 'failed')
    .map(item => ({
      name: String(item.fullName ?? item.name ?? '?').replace(/\s+/g, ' ').trim(),
      message: String((item.failureMessages ?? []).join(' ')).replace(/\s+/g, ' ').trim(),
    }));
}

/**
 * What kind of failure this file had, so a reader does not have to guess.
 *
 * "timing" and "environment" are the two classes that are not about the code
 * under test, and telling them apart from an assertion is the difference
 * between re-running and reading a diff.
 */
function failureKind(result) {
  // The first line only: a stack trace names files and settings, and matching
  // on it calls every assertion a timeout because the runner's own paths are in it.
  const text = firstFailures(result).map(item => item.message.split(' at /')[0]).join(' ');
  // A narrower class than "environment": the child process never started
  // because *this* executor refused it (a sandbox that denies sandbox_apply, an
  // executor that denies spawning hdiutil). Measured 2026-11-01: running the
  // gate inside an Agent's own executor reported 13 files / 32 tests red, and
  // every one of them was this refusal - the code under test could not run at
  // all. The host gate runs the same files where the capability exists.
  if (/sandbox_apply|spawn EPERM|EPERM: operation not permitted|Process failed to launch/i.test(text)) return 'executor';
  if (/timed out|timeout|did not succeed in time|ETIMEDOUT/i.test(text)) return 'timing';
  if (/Operation not permitted|EPERM|EACCES|ENOTFOUND|ECONNREFUSED|Cannot find module/i.test(text)) return 'environment';
  return 'assertion';
}

/** Files whose only failure was this executor refusing to start the child process. */
function refusedByExecutor(file) {
  const result = report.testResults.find(entry => relative(entry.name) === file);
  return Boolean(result) && failureKind(result) === 'executor';
}

/**
 * A file that failed once is re-run alone, once, before it blocks anything.
 *
 * Under six workers the machine is busy enough that a test asserting a real
 * fact can miss its own budget: measured 2026-10-31, two runs of one commit
 * failed in different files and each passed when re-run alone. A gate that
 * cannot tell "busy machine" from "broken code" turns every red into a
 * re-run experiment, which is exactly the minute it costs.
 *
 * The first failure is always printed with its kind and its first line, the
 * retry is named when it happens, and a regression fails both attempts and
 * still blocks.
 */
function retryOnce(files) {
  const retryReport = join(root, 'tests/.suite-retry-report.json');
  spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', ...files,
    // Same layer excludes as the first run: a layer that was skipped is not a
    // failure to retry.
    ...layerExcludes.flatMap(glob => ['--exclude', glob]),
    // bail=1 would stop the retry at the first failure and leave the rest
    // unrun, which would read as "they passed".
    '--bail=0',
    '--reporter=default', '--reporter=json', `--outputFile=${retryReport}`,
  ], { stdio: 'inherit', cwd: root });
  try {
    const second = JSON.parse(readFileSync(retryReport, 'utf8'));
    return {
      stillFailing: second.testResults.filter(result => result.status === 'failed').map(result => relative(result.name)),
      recovered: files.filter(file => !second.testResults.some(result => relative(result.name) === file && result.status === 'failed')),
      results: second.testResults,
    };
  } catch {
    return { stillFailing: files, recovered: [], results: [] };
  }
}

if (quarantined.size) {
  console.log(`\ncheck:tests: ${quarantined.size} quarantined file(s) still run, and do not block the gate:`);
  for (const [file, reason] of quarantined) console.log(`  - ${file}${excused.includes(file) ? '  [FAILED this run]' : ''} — ${reason}`);
}
if (stale.length) console.log(`check:tests: stale quarantine entry/entries, no such test ran: ${stale.join(', ')}`);
if (skippedLayers.length) console.log(`check:tests: verified ${layers.length - skippedLayers.length}/${layers.length} environment layer(s) in this run`);
if (excused.length) console.log(`check:tests: ${excused.length} quarantined failure(s), reported and not blocking: ${excused.join(', ')}`);
let retriedFiles = [];
// An executor that cannot start a child process has not tested anything: those
// files are reported as unverified here and do not block, because re-running
// them would prove only that the executor still refuses. Everything else -
// including a real environment failure - goes through the retry and the gate.
const refused = blocking.filter(refusedByExecutor);
const blockingReal = blocking.filter(file => !refused.includes(file));
if (refused.length) {
  console.error(`\ncheck:tests: ${refused.length} file(s) could NOT be verified here - this executor refused to start the child process:`);
  for (const file of refused) {
    const result = report.testResults.find(entry => relative(entry.name) === file);
    const item = result ? firstFailures(result)[0] : undefined;
    console.error(`  - ${file}${item ? ` — ${item.message.slice(0, 160)}` : ''}`);
  }
  console.error('check:tests: they are not called passing; the host gate runs them where the capability exists');
}
// The full run already excuses a failure that matches tests/env-known-reds.json;
// the fast gate has to use the same rule, otherwise a known environment problem
// blocks every commit that touches its file.
const knownReds = (() => {
  try { return JSON.parse(readFileSync(join(root, 'tests/env-known-reds.json'), 'utf8')).reds; } catch { return []; }
})();
function knownEnvironment(file, result) {
  const patterns = knownReds.filter(red => red.file === file);
  if (!patterns.length || !result) return undefined;
  const messages = firstFailures(result).map(item => `${item.name} — ${item.message}`).join('\n');
  return patterns.find(red => messages.includes(red.pattern));
}

if (blockingReal.length) {
  const details = report.testResults.filter(result => blockingReal.includes(relative(result.name)));
  console.error(`\ncheck:tests: ${blockingReal.length} failure(s) outside the quarantine:`);
  for (const result of details) {
    console.error(`  - ${relative(result.name)} [${failureKind(result)}]`);
    for (const item of firstFailures(result).slice(0, 3)) {
      console.error(`      × ${item.name.slice(0, 160)} — ${item.message.slice(0, 240)}`);
    }
  }
  console.error('check:tests: re-running those file(s) alone once, to tell a busy machine from broken code');
  const retry = retryOnce(blockingReal);
  if (retry.recovered.length) {
    retriedFiles = retry.recovered;
    console.log(`check:tests: ${retry.recovered.length} file(s) failed once and passed on a re-run: ${retry.recovered.join(', ')}`);
  }
  if (retry.stillFailing.length) {
    const environment = [];
    const regressions = [];
    for (const file of retry.stillFailing) {
      const result = retry.results.find(entry => relative(entry.name) === file);
      const red = knownEnvironment(file, result);
      if (red) environment.push({ file, red });
      else regressions.push(file);
    }
    if (environment.length) {
      console.log(`\ncheck:tests: ${environment.length} failure(s) match tests/env-known-reds.json, so they are environment and do not block:`);
      for (const { file, red } of environment) console.log(`  - ${file} — ${red.pattern}: ${red.why}`);
    }
    if (regressions.length) {
      console.error(`\ncheck:tests: ${regressions.length} file(s) failed twice, so the gate stops here:`);
      for (const file of regressions) console.error(`  - ${file}`);
      const second = retry.results.find(result => regressions.includes(relative(result.name)));
      if (second) {
        for (const item of firstFailures(second).slice(0, 3)) {
          console.error(`      × [${failureKind(second)}] ${item.name.slice(0, 160)} — ${item.message.slice(0, 240)}`);
        }
      }
      process.exit(1);
    }
  }
}
if (process.env.GRAPH_STRICT_SUITE === '1' && failed.length) {
  console.error('check:tests: strict mode fails on any failure, quarantined ones included');
  process.exit(1);
}
console.log(`check:tests: ${report.numPassedTests}/${report.numTotalTests} tests passed${excused.length ? `, ${excused.length} quarantined failure(s)` : ''}${retriedFiles.length ? `; ${retriedFiles.length} file(s) recovered on a re-run: ${retriedFiles.join(', ')}` : ''}${refused.length ? `; ${refused.length} file(s) unverified here (executor refused to start the child)` : ''}`);

// The quarantine is a loan, not a home: a file that keeps passing gets named
// here, so the list only shrinks on purpose instead of growing forever.
const history = (() => { try { return JSON.parse(readFileSync(historyPath, 'utf8')); } catch { return { runs: [] }; } })();
const snapshot = {
  at: new Date().toISOString(),
  files: [...quarantined.keys()].map(file => ({
    path: file,
    status: failed.includes(file) ? 'failed' : ran.has(file) ? 'passed' : 'missing',
  })),
};
history.runs = [...(history.runs ?? []), snapshot].slice(-30);
writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
const GREEN_RUNS = 3;
for (const [file] of quarantined) {
  // Count the whole streak, not just the last three runs, and speak only when
  // the streak first becomes worth acting on. A hint on every single run for
  // the rest of the quarantine's life is noise people learn to scroll past.
  let streak = 0;
  for (const item of [...history.runs].reverse()) {
    if (item.files.find(entry => entry.path === file)?.status !== 'passed') break;
    streak += 1;
  }
  if (streak === GREEN_RUNS || streak === GREEN_RUNS * 3) {
    console.log(`check:tests: ${file} passed the last ${streak} runs — take it out of tests/quarantine.json`);
  }
}
