// @ts-check
/**
 * diag-c: read-only integrity check for this repository's npm scripts.
 *
 * It answers one question: does every script we promise to be able to run
 * actually resolve? Specifically it walks `package.json#scripts` and reports
 *
 *   - `node --run X` / `npm run X` / `pnpm run X` / `yarn run X` references to
 *     a subcommand that is not defined in `package.json`;
 *   - file paths a script hands to an interpreter (e.g. `node scripts/x.mjs`,
 *     `tsc -p tsconfig.web.json`) that do not exist on disk;
 *   - mutual recursion between scripts, which would make a run hang;
 *   - a missing `check` entry point, the convention this repo's tooling relies on.
 *
 * Nothing is written and no dependency beyond Node's built-ins is used, so the
 * script is safe to run anywhere and its output can be treated as evidence.
 *
 * Usage:
 *   node scripts/diag-c.mjs [repoRoot]   # defaults to the repo this file lives in
 *
 * Exit code: 0 when the script graph is complete, 1 when a problem is found.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

/** Invocations that run another named npm script. */
const SCRIPT_RUNNERS = [
  /\bnode\s+--run\s+([\w:.@/-]+)/g,
  /\bnpm\s+run\s+(?:--silent\s+|--\s+)?([\w:.@/-]+)/g,
  /\bpnpm\s+run\s+([\w:.@/-]+)/g,
  /\byarn\s+run\s+([\w:.@/-]+)/g,
];

/** A whitespace-delimited token that looks like a path to a file on disk. */
const FILE_TOKEN = /(?:^|[\s"'=(])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|json|html|css))\b/g;

/**
 * Names of npm scripts referenced by a command string.
 * @param {string} command
 * @returns {string[]}
 */
export function referencedScripts(command) {
  const names = new Set();
  for (const pattern of SCRIPT_RUNNERS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(command)) !== null) names.add(match[1]);
  }
  return [...names];
}

/**
 * File paths referenced by a command string.
 * @param {string} command
 * @returns {string[]}
 */
export function referencedFiles(command) {
  const paths = new Set();
  FILE_TOKEN.lastIndex = 0;
  let match;
  while ((match = FILE_TOKEN.exec(command)) !== null) paths.add(match[1]);
  return [...paths];
}

/**
 * Every script reachable from a start script, following script-to-script references.
 * @param {Record<string, string>} scripts
 * @param {string} start
 * @returns {Set<string>}
 */
export function reachableScripts(scripts, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    for (const next of referencedScripts(scripts[name] ?? '')) {
      if (next in scripts && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/**
 * Cycles in the script reference graph, each reported once. A mutual
 * `a -> b -> a` pair must be found without recursing forever.
 * @param {Record<string, string>} scripts
 * @returns {string[][]}
 */
export function findCycles(scripts) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    graph.set(name, referencedScripts(command).filter(next => next in scripts));
  }
  /** 0 = unvisited, 1 = on the current path, 2 = done */
  const state = new Map();
  /** @type {string[][]} */
  const cycles = [];
  const reported = new Set();

  /** @param {string} node @param {string[]} path */
  function visit(node, path) {
    state.set(node, 1);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = path.slice(path.indexOf(next));
        const key = [...new Set(cycle)].sort().join(' -> ');
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
      } else if ((state.get(next) ?? 0) === 0) {
        visit(next, path);
      }
    }
    path.pop();
    state.set(node, 2);
  }

  for (const name of graph.keys()) {
    if ((state.get(name) ?? 0) === 0) visit(name, []);
  }
  return cycles;
}

/**
 * @param {Record<string, string>} scripts
 * @param {string} root
 * @returns {string[]}
 */
export function diagnose(scripts, root) {
  const problems = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const referenced of referencedScripts(command)) {
      if (!(referenced in scripts)) {
        problems.push(`${name}: references missing subcommand \`${referenced}\``);
      }
    }
    for (const file of referencedFiles(command)) {
      if (!existsSync(join(root, file))) {
        problems.push(`${name}: references missing file \`${file}\``);
      }
    }
  }
  for (const cycle of findCycles(scripts)) {
    problems.push(`cycle in script references: ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  if (!('check' in scripts)) problems.push('no `check` script: the repo convention has no entry point');
  return problems;
}

function main() {
  const root = resolve(process.argv[2] ?? DEFAULT_ROOT);
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest) || !statSync(manifest).isFile()) {
    console.error(`diag-c: no package.json found at ${root}`);
    process.exit(1);
  }

  /** @type {{ scripts?: Record<string, string> }} */
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const scripts = pkg.scripts ?? {};

  const problems = diagnose(scripts, root);
  const reachable = reachableScripts(scripts, 'check');

  console.log('diag-c: npm script integrity (read-only)');
  console.log(`repository: ${root}`);
  console.log(`scripts: ${Object.keys(scripts).length} total, ${reachable.size} reachable from \`check\``);
  if ('check' in scripts) {
    console.log('');
    console.log('`check` expands to:');
    console.log(`  ${scripts.check}`);
  }
  console.log('');

  if (problems.length > 0) {
    console.error(`Problems: ${problems.length}`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }

  console.log('Problems: 0');
  console.log('OK: every referenced subcommand, file and script chain resolves.');
}

/**
 * Run only when this file is the entry point.
 *
 * Both sides go through realpathSync: `import.meta.url` is already resolved, so comparing it with a
 * lexical `resolve(argv[1])` is false whenever argv[1] keeps a symlink - macOS /tmp, $TMPDIR, or a
 * symlinked checkout. That made the script a silent no-op (0 bytes out, exit 0, identical to a clean
 * run), the worst possible failure for a checker whose contract is "exit 0 = no problems".
 */
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
