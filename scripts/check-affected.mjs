#!/usr/bin/env node
// The blocking gate never runs the whole suite.
//
// Measured 2026-11-05: the full suite is 309-345s and the rest of the gate is
// about ten seconds warm (backend 1s, typecheck 0-1s, lint 1s, harness gate 7s,
// ownership/tokens/baseline/evidence ~1s), so a commit waited five minutes for a
// decision that a bounded run answers in seconds. Everything the blocking run
// leaves out is proved after the reload by the async full run, which wakes main
// with the failure instead of holding the commit.
//
// What the blocking run does cover, in order of preference:
//   - the leaf tests the change itself touched (tests/<layer>/<file>.test.ts);
//   - the in-process layers that need no daemon or window (console, app, m7, m8)
//     whenever src/web, src/core or desktop moved;
//   - the pure layers only, for anything else.
// A change to shared test infrastructure (helpers, fixtures, env-layers,
// quarantine) deliberately does NOT pull the suite in: that is exactly the case
// the async full run exists for.
// GRAPH_CHECK_FULL=1 forces everything, for CI; GRAPH_CHECK_BASE pins the base.
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function resolveBase() {
  // The gate runs before the commit, so the pending change is the working tree:
  // HEAD is the base that measures exactly what this change touches. A BRANCH
  // base (GRAPH_CHECK_BASE=origin/main) answers a different question - what this
  // whole branch changed - and on a long-lived branch that is always wide.
  for (const candidate of [process.env.GRAPH_CHECK_BASE, 'HEAD', 'origin/main', 'main', 'HEAD~1']) {
    if (!candidate) continue;
    if (git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).status !== 0) continue;
    const mergeBase = git(['merge-base', 'HEAD', candidate]);
    return (mergeBase.status === 0 ? mergeBase.stdout.trim() : candidate) || candidate;
  }
  return null;
}

function changedPaths(base) {
  const paths = new Set();
  if (base) {
    const committed = git(['diff', '--name-only', `${base}...HEAD`]);
    for (const line of committed.stdout.split('\n')) if (line.trim()) paths.add(line.trim());
  }
  const working = git(['status', '--porcelain']);
  for (const line of working.stdout.split('\n')) {
    const path = line.slice(3).trim();
    if (path) paths.add(path.includes(' -> ') ? path.split(' -> ')[1] : path);
  }
  return [...paths];
}

const WEB = ['src/web/', 'src/core/', 'desktop/'];
// A schema migration is proved by the old databases it upgrades, and by nothing
// else: no in-process layer opens a v13 file. Mapping the store to that keeper is
// what would have caught "duplicate column name" before the commit instead of in
// the async full run after it.
const STORE = /^backend\/internal\/graph\/core_store/;
const STORE_KEEPER = 'tests/e2e/go-schema-upgrade.test.ts';
// Layers that run in-process: no daemon, no window, no vendor. Seconds, not minutes.
const IN_PROCESS = ['tests/console', 'tests/app', 'tests/m7', 'tests/m8'];
const LEAF = /^tests\/[^/]+\/[^/]+\.test\.ts$/;

const base = resolveBase();
const changed = changedPaths(base);
const forced = process.env.GRAPH_CHECK_FULL === '1';
const leafTests = changed.filter(path => LEAF.test(path));
const sharedTests = changed.filter(path => path.startsWith('tests/') && !LEAF.test(path));
const web = changed.some(path => WEB.some(prefix => path.startsWith(prefix)));
const store = changed.some(path => STORE.test(path));
// A change that names no path at all (a detached checkout, an empty diff) runs
// the in-process layers: bounded, and still every layer that can answer offline.
const selection = forced
  ? { label: 'forced full (CI)', files: [] }
  : store
    ? { label: leafTests.length ? `schema keeper + ${leafTests.length} changed leaf test(s)` : 'schema upgrade keeper', files: [...new Set([STORE_KEEPER, ...leafTests])] }
    : leafTests.length
      ? { label: `${leafTests.length} changed leaf test(s)`, files: leafTests }
      : { label: web ? 'in-process layers' : 'pure layers', files: web ? IN_PROCESS : ['tests/console', 'tests/app', 'tests/m7'] };

console.log(`check:affected: base ${base ?? '(none)'}, ${changed.length} changed path(s)`);
for (const path of changed.slice(0, 20)) console.log(`  - ${path}`);
if (changed.length > 20) console.log(`  … ${changed.length - 20} more`);
console.log(`check:affected: blocking run covers ${selection.label}: ${selection.files.length ? selection.files.join(' ') : 'everything'}`);
if (sharedTests.length) console.log(`check:affected: shared test infrastructure changed (${sharedTests.join(' ')}); the async full run after the reload is what proves it`);
console.log('check:affected: the full suite never blocks a commit; it runs after the reload and wakes main if it fails');

if (process.env.GRAPH_CHECK_PLAN_ONLY === '1') {
  // Operators and the agent read the decision without paying for the run.
  console.log('check:affected: plan only, no test was run');
  process.exit(0);
}
// The quarantine decision lives in check:tests, so the bounded run and the async
// full run excuse the same files instead of one of them blocking on a flake.
const args = ['scripts/check-tests.mjs', ...selection.files];
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (run.status !== 0) {
  console.error('check:affected: the blocking run failed; the async full run is the confirmation, not a substitute');
  process.exit(run.status ?? 1);
}
console.log(`check:affected: ${selection.label} passed`);
