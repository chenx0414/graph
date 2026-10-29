#!/usr/bin/env node
// The blocking gate runs the suite tier a change can actually affect.
//
// vitest's own --changed follows import edges, and the e2e tests drive a real
// daemon process instead of importing the Go backend, so a backend change selects
// nothing there. This decides by area instead, and says which area it decided:
//   - web:   src/web, src/core, desktop or tests/m8 changed -> the browser tier runs
//   - wide:  scripts, package.json, vitest config, tests, presets or docs changed
//            -> everything runs, because the gate itself or a shared fixture moved
//   - core:  otherwise the backend tiers run and the browser tier is skipped
// GRAPH_CHECK_FULL=1 forces everything; GRAPH_CHECK_BASE pins the base revision.
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function resolveBase() {
  for (const candidate of [process.env.GRAPH_CHECK_BASE, 'origin/main', 'main', 'HEAD~1']) {
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
const WIDE = ['scripts/', 'tests/', 'presets/', 'docs/', 'package.json', 'vitest.config.ts', 'tsconfig'];

const base = resolveBase();
const changed = changedPaths(base);
const forced = process.env.GRAPH_CHECK_FULL === '1';
const wide = forced || !base || !changed.length || changed.some(path => WIDE.some(prefix => path.startsWith(prefix)));
const web = forced || wide || changed.some(path => WEB.some(prefix => path.startsWith(prefix)));

console.log(`check:affected: base ${base ?? '(none)'}, ${changed.length} changed path(s)`);
for (const path of changed.slice(0, 20)) console.log(`  - ${path}`);
if (changed.length > 20) console.log(`  … ${changed.length - 20} more`);
console.log(`check:affected: tier ${wide ? 'wide (everything)' : web ? 'web + core' : 'core only'}${forced ? ' (forced full)' : ''}`);

const args = ['node_modules/vitest/vitest.mjs', 'run', '--bail=0'];
if (!wide) {
  // The browser tier is the slow one and only a web change can move it.
  args.push('--exclude', '**/tests/m8/**');
}
for (const file of wide || web ? [] : []) args.push(file);
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (run.status !== 0) {
  console.error('check:affected: the affected tier failed; the full suite is the async confirmation, not a substitute');
  process.exit(run.status ?? 1);
}
console.log(`check:affected: ${wide ? 'full' : web ? 'web + core' : 'core'} tier passed`);
