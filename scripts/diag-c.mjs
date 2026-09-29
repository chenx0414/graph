// @ts-check
/**
 * diag-c: a read-only integrity check for this repository's npm scripts.
 *
 * The question it answers is small and mechanical: does every script this
 * package promises to be able to run actually resolve? It walks
 * `package.json#scripts` and reports
 *
 *   - a reference to another npm script that is not defined here
 *     (`node --run X`, `npm run X`, `pnpm run X`, `yarn run X`);
 *   - a file path handed to a tool that is not on disk
 *     (`node scripts/x.mjs`, `tsc -p tsconfig.web.json`);
 *   - a loop between scripts, which would make a run hang instead of finish;
 *   - a missing `check` entry point, the convention this repository's tooling
 *     and its documentation rely on.
 *
 * Nothing is created, moved or executed, and the only imports are Node
 * built-ins, so the output is evidence rather than a side effect: the same
 * repository always produces the same bytes.
 *
 * Usage:
 *   node scripts/diag-c.mjs [repoRoot]
 *
 * `repoRoot` defaults to the repository this file lives in, never to the
 * current directory, so the report describes one known tree.
 *
 * Exit code: 0 when every script reference resolves, 1 when a problem is
 * found or the repository cannot be read.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

/**
 * A command that runs another named script, with the optional flags the
 * runners accept on either side of the verb.
 */
const SCRIPT_RUNNER =
  /\b(?:node\s+--run|(?:npm|pnpm|yarn)\s+(?:--?[\w-]+\s+)*run(?:-script)?)\s+(?:--?[\w-]+\s+)*([\w:.@/-]+)/g;

/** A whitespace- or quote-delimited token that names a file with a code/config extension. */
const FILE_TOKEN =
  /(?:^|[\s"'=(])((?:\.{0,2}\/|\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|json|yaml|yml))\b/g;

const CODE_EXTENSIONS = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|json|yaml|yml)$/;

/**
 * Names of npm scripts that a command string runs.
 * @param {string} command
 * @returns {string[]}
 */
export function referencedScripts(command) {
  const names = new Set();
  SCRIPT_RUNNER.lastIndex = 0;
  let match;
  while ((match = SCRIPT_RUNNER.exec(command)) !== null) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/**
 * File paths a command string names. Absolute paths are kept absolute;
 * everything else is relative to the repository root.
 * @param {string} command
 * @returns {string[]}
 */
export function referencedFiles(command) {
  const paths = new Set();
  FILE_TOKEN.lastIndex = 0;
  let match;
  while ((match = FILE_TOKEN.exec(command)) !== null) {
    const path = match[1];
    if (path !== undefined && CODE_EXTENSIONS.test(path)) paths.add(path);
  }
  return [...paths];
}

/**
 * Where a referenced path is expected to be. An absolute token is not joined
 * onto the root, which would silently turn `/a/b.mjs` into `<root>/a/b.mjs`
 * and then report a file that does exist as missing.
 * @param {string} path
 * @param {string} root
 */
export function expectedPath(path, root) {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Every script reachable from a starting script, following script-to-script
 * references. Used to report how much of the manifest the `check` chain
 * actually pulls in.
 * @param {Record<string, string>} scripts
 * @param {string} start
 * @returns {string[]}
 */
export function reachableScripts(scripts, start) {
  /** @type {string[]} */
  const order = [];
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name) || !(name in scripts)) continue;
    seen.add(name);
    order.push(name);
    for (const next of referencedScripts(scripts[name] ?? '')) {
      if (next in scripts && !seen.has(next)) queue.push(next);
    }
  }
  return order;
}

/**
 * A stable name for a loop, so the same loop found from two of its own nodes is
 * reported once. Rotating to the smallest node makes the name independent of
 * where the walk entered the loop, while two different loops keep different
 * names even when they share nodes.
 * @param {string[]} cycle
 */
function cycleKey(cycle) {
  const smallest = [...cycle].sort()[0] ?? cycle[0] ?? '';
  const at = cycle.indexOf(smallest);
  return [...cycle.slice(at), ...cycle.slice(0, at)].join(' -> ');
}

/**
 * Loops in the script reference graph, each reported once. A `check` that runs
 * `test` which runs `check` must be found without recursing forever.
 * @param {Record<string, string>} scripts
 * @returns {string[][]}
 */
export function findCycles(scripts) {
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  for (const [name, command] of Object.entries(scripts)) {
    edges.set(name, referencedScripts(command).filter((next) => next in scripts));
  }
  /** 0 = unvisited, 1 = on the current path, 2 = finished */
  const state = new Map();
  /** @type {Map<string, string[]>} */
  const found = new Map();

  /** @param {string} node @param {string[]} path */
  function visit(node, path) {
    state.set(node, 1);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = path.slice(path.indexOf(next));
        const key = cycleKey(cycle);
        if (!found.has(key)) found.set(key, cycle);
      } else if ((state.get(next) ?? 0) === 0) {
        visit(next, path);
      }
    }
    path.pop();
    state.set(node, 2);
  }

  for (const name of edges.keys()) {
    if ((state.get(name) ?? 0) === 0) visit(name, []);
  }
  return [...found.keys()].map((key) => key.split(' -> '));
}

/**
 * Every problem in one manifest, in the order a reader wants to see them.
 * @param {Record<string, string>} scripts
 * @param {string} root
 * @returns {string[]}
 */
export function diagnose(scripts, root) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') {
      problems.push(`${name}: script body is not a string (${typeof command})`);
      continue;
    }
    for (const referenced of referencedScripts(command)) {
      if (!(referenced in scripts)) {
        problems.push(`${name}: references missing subcommand \`${referenced}\``);
      }
    }
    for (const path of referencedFiles(command)) {
      if (!existsSync(expectedPath(path, root))) {
        problems.push(`${name}: references missing file \`${path}\``);
      }
    }
  }
  for (const cycle of findCycles(scripts)) {
    const first = cycle[0] ?? '';
    problems.push(`cycle in script references: ${cycle.join(' -> ')} -> ${first}`);
  }
  if (!('check' in scripts)) {
    problems.push('no `check` script: the repository convention has no entry point');
  }
  return problems;
}

/**
 * @param {string} root
 * @returns {{ scripts: Record<string, string> } | { error: string }}
 */
function readScripts(root) {
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest) || !statSync(manifest).isFile()) {
    return { error: `diag-c: no package.json found at ${root}` };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (error) {
    return { error: `diag-c: cannot parse ${manifest}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `diag-c: ${manifest} is not a JSON object` };
  }
  const scripts = (/** @type {{ scripts?: unknown }} */ (parsed)).scripts;
  if (scripts === undefined) return { scripts: {} };
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return { error: `diag-c: ${manifest}#scripts is not an object` };
  }
  return { scripts: /** @type {Record<string, string>} */ (scripts) };
}

function main() {
  const root = resolve(process.argv[2] ?? DEFAULT_ROOT);
  const loaded = readScripts(root);
  if ('error' in loaded) {
    console.error(loaded.error);
    process.exit(1);
  }

  const { scripts } = loaded;
  const names = Object.keys(scripts);
  const reachable = reachableScripts(scripts, 'check');
  const problems = diagnose(scripts, root);

  console.log('diag-c: npm script integrity (read-only)');
  console.log(`repository: ${root}`);
  console.log(`scripts: ${names.length} total, ${reachable.length} reachable from \`check\``);
  console.log(`reachable from \`check\`: ${reachable.length > 0 ? reachable.join(', ') : '(none)'}`);
  if (typeof scripts.check === 'string') {
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
  console.log('OK: every referenced subcommand, file path and script chain resolves.');
}

/**
 * True only when this file is the process entry point.
 *
 * `import.meta.url` is always fully resolved by Node while a path typed on the
 * command line may keep a symlink in any of its components - macOS `/tmp`,
 * `/var` and `$TMPDIR` all do. Comparing a lexical `resolve(argv[1])` with it
 * is therefore false for a symlinked spelling, and that turned this script into
 * a silent no-op: no output, exit 0, indistinguishable from a clean run. Both
 * sides go through `realpathSync` instead, and a path that cannot be resolved
 * (a host importing this file after its own entry point has gone stale) counts
 * as "not the entry point" rather than throwing.
 */
function isEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
