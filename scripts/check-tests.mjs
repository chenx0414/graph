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
const run = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run',
  // bail=1 would stop the suite at the first failure, which makes a quarantined
  // failure look like a shrunk suite to the baseline check and hides whatever
  // else would have failed. The gate decides from a complete report.
  '--bail=0',
  // The caller decides the tier (check:affected forwards an --exclude); the
  // quarantine decision stays here so both tiers excuse the same files.
  ...process.argv.slice(2),
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

if (quarantined.size) {
  console.log(`\ncheck:tests: ${quarantined.size} quarantined file(s) still run, and do not block the gate:`);
  for (const [file, reason] of quarantined) console.log(`  - ${file}${excused.includes(file) ? '  [FAILED this run]' : ''} — ${reason}`);
}
if (stale.length) console.log(`check:tests: stale quarantine entry/entries, no such test ran: ${stale.join(', ')}`);
if (excused.length) console.log(`check:tests: ${excused.length} quarantined failure(s), reported and not blocking: ${excused.join(', ')}`);
if (blocking.length) {
  console.error(`\ncheck:tests: ${blocking.length} failure(s) outside the quarantine:`);
  for (const file of blocking) console.error(`  - ${file}`);
  process.exit(1);
}
if (process.env.GRAPH_STRICT_SUITE === '1' && failed.length) {
  console.error('check:tests: strict mode fails on any failure, quarantined ones included');
  process.exit(1);
}
console.log(`check:tests: ${report.numPassedTests}/${report.numTotalTests} tests passed${excused.length ? `, ${excused.length} quarantined failure(s)` : ''}`);

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
  if (streak === GREEN_RUNS || streak >= GREEN_RUNS * 3) {
    console.log(`check:tests: ${file} passed the last ${streak} runs — take it out of tests/quarantine.json`);
  }
}
