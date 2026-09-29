/**
 * diag-b - read-only source size and module directory distribution.
 *
 * Answers "how big is each src/<module> area, and where does the bulk sit?" without touching the
 * working tree: it walks `src/`, groups files by their top-level module directory (src/core,
 * src/runtime, src/web, ...) and prints a summary of file count, line count and bytes per module,
 * plus the largest files.
 *
 * Read-only by construction - it only uses `node:fs` reads and never writes, and it imports nothing
 * outside the Node builtins.
 *
 * Run: node scripts/diag-b.mjs [root]        root defaults to the repository's src/
 *      node scripts/diag-b.mjs --self-test   run the built-in fixture check (the only mode that
 *                                            can exit nonzero)
 *
 * Exit codes: diagnostic mode always exits 0, even when the root is missing or an individual file
 * is unreadable - it reports those instead of aborting, because a diagnostic that dies on one bad
 * input is not usable. `--self-test` exits 1 when the counted result does not match its fixture.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

/** Extensions treated as countable source. Anything else (images, fonts) is skipped, not guessed. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.css', '.html', '.json', '.md']);
/** Directories never walked even if they appear under the root. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

const repoRoot = resolve(import.meta.dirname, '..');

/** Count lines the way an editor does: a trailing newline terminates the last line, it does not add one. */
function countLines(content) {
  if (!content) return 0;
  const newlines = content.split('\n').length - 1;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/** Every countable file under `directory`, recursively. */
function collectFiles(directory) {
  const files = [];
  // Sorted so the report (and the self-test's ordered comparison) does not depend on readdir order.
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) files.push(...collectFiles(join(directory, entry.name)));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(join(directory, entry.name));
  }
  return files;
}

/**
 * The module bucket a path belongs to: `src/core/graph.ts` -> `src/core`; a loose `src/x.ts` -> `src`.
 * A path outside the repository (an explicit `[root]` argument) is labelled by its own directory
 * rather than the meaningless `../..` a naive slice of the repo-relative path would produce.
 */
function moduleOf(file) {
  const rel = relative(repoRoot, file).split('/');
  if (!rel[0]?.startsWith('..')) return rel.length > 2 ? rel.slice(0, 2).join('/') : rel[0];
  return basename(dirname(file)) || '.';
}

/** Show a repo-relative path when the file is inside the repo, its absolute path otherwise. */
function displayPath(file) {
  const rel = relative(repoRoot, file);
  return rel.startsWith('..') ? file : rel;
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pad(value, width, alignRight = false) {
  const text = String(value);
  if (text.length >= width) return text;
  const filler = ' '.repeat(width - text.length);
  return alignRight ? filler + text : text + filler;
}

function printTable(title, headers, rows) {
  console.log(`\n${title}`);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => String(row[index]).length)));
  const render = cells => cells.map((cell, index) => pad(cell, widths[index], index > 0)).join('  ');
  console.log(render(headers));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(render(row));
}

/**
 * Read the tree once and fold it into the numbers we print. Unreadable files are collected instead
 * of thrown: one EACCES file must not take down the whole report, which claims to be a diagnostic.
 */
function collect(root) {
  const names = statSync(root).isDirectory() ? collectFiles(root) : [root];
  const modules = new Map();
  const extensions = new Map();
  const files = [];
  const unreadable = [];

  for (const file of names) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      unreadable.push(displayPath(file));
      continue;
    }
    const lines = countLines(content);
    const bytes = Buffer.byteLength(content);

    const module = moduleOf(file);
    const bucket = modules.get(module) ?? { files: 0, lines: 0, bytes: 0 };
    bucket.files += 1;
    bucket.lines += lines;
    bucket.bytes += bytes;
    modules.set(module, bucket);

    const extension = extname(file) || '(none)';
    const extended = extensions.get(extension) ?? { files: 0, lines: 0 };
    extended.files += 1;
    extended.lines += lines;
    extensions.set(extension, extended);

    files.push({ path: displayPath(file), lines, bytes });
  }

  const totals = files.reduce(
    (sum, file) => ({ files: sum.files + 1, lines: sum.lines + file.lines, bytes: sum.bytes + file.bytes }),
    { files: 0, lines: 0, bytes: 0 },
  );
  return { modules, extensions, files, unreadable, totals };
}

function render(root, collected) {
  const { modules, extensions, files, unreadable, totals } = collected;

  console.log('diag-b - source size and module distribution (read-only)');
  console.log(`root: ${root}`);
  console.log(`source files: ${totals.files}, lines: ${totals.lines}, size: ${humanBytes(totals.bytes)}`);
  if (unreadable.length) console.log(`unreadable (skipped): ${unreadable.length} - ${unreadable.join(', ')}`);

  const moduleRows = [...modules.entries()]
    .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
    .map(([module, stats]) => [module, stats.files, stats.lines, humanBytes(stats.bytes), `${totals.lines ? ((stats.lines / totals.lines) * 100).toFixed(1) : '0.0'}%`]);
  moduleRows.push(['total', totals.files, totals.lines, humanBytes(totals.bytes), '100.0%']);
  printTable('By module directory', ['module', 'files', 'lines', 'size', 'share'], moduleRows);

  const extensionRows = [...extensions.entries()]
    .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
    .map(([extension, stats]) => [extension, stats.files, stats.lines]);
  printTable('By extension', ['ext', 'files', 'lines'], extensionRows);

  const largest = [...files].sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, 10);
  printTable('Largest files', ['file', 'lines', 'size'], largest.map(file => [file.path, file.lines, humanBytes(file.bytes)]));
}

/**
 * A fixture whose expected counts are written by hand, so the check cannot agree with the code by
 * construction. It covers the two shapes that bit us: a file with no trailing newline (line count),
 * a non-source extension (skipped), and counting a root outside the repository (module labelling).
 */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'diag-b-selftest-'));
  try {
    for (const [path, body] of [
      ['core/a.ts', 'a\nb\nc\n'],
      ['core/b.ts', 'x\ny\n'],
      ['web/c.tsx', 'p\nq\nr\ns'],
      ['web/skip.png', 'not counted\n'],
      ['loose.md', 'one\n'],
    ]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }

    const collected = collect(root);
    const byModule = Object.fromEntries([...collected.modules.entries()].map(([name, stats]) => [name, { files: stats.files, lines: stats.lines }]));
    const expected = {
      totals: { files: 4, lines: 10 },
      modules: {
        core: { files: 2, lines: 5 },
        web: { files: 1, lines: 4 },
        [basename(root)]: { files: 1, lines: 1 },
      },
      extensions: { '.ts': { files: 2, lines: 5 }, '.tsx': { files: 1, lines: 4 }, '.md': { files: 1, lines: 1 } },
    };
    const actualExtensions = Object.fromEntries([...collected.extensions.entries()].map(([name, stats]) => [name, { files: stats.files, lines: stats.lines }]));
    // Compare by key, not by insertion order: the report sorts for display, the check must not care.
    const canonical = value => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

    const problems = [];
    if (collected.totals.files !== expected.totals.files || collected.totals.lines !== expected.totals.lines) {
      problems.push(`totals: expected ${JSON.stringify(expected.totals)}, got ${{ files: collected.totals.files, lines: collected.totals.lines }}`);
    }
    if (JSON.stringify(canonical(byModule)) !== JSON.stringify(canonical(expected.modules))) {
      problems.push(`modules: expected ${JSON.stringify(canonical(expected.modules))}, got ${JSON.stringify(canonical(byModule))}`);
    }
    if (JSON.stringify(canonical(actualExtensions)) !== JSON.stringify(canonical(expected.extensions))) {
      problems.push(`extensions: expected ${JSON.stringify(canonical(expected.extensions))}, got ${JSON.stringify(canonical(actualExtensions))}`);
    }

    if (problems.length) {
      console.error('diag-b --self-test: FAIL');
      for (const problem of problems) console.error(`- ${problem}`);
      // Set the code instead of process.exit: exiting here would skip the finally that removes the fixture.
      process.exitCode = 1;
      return;
    }
    console.log('diag-b --self-test: PASS (4 files, 10 lines; module + extension buckets match the fixture)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv[2] === '--self-test') {
    selfTest();
    return;
  }
  const root = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'src');
  try {
    render(root, collect(root));
  } catch {
    console.error(`diag-b: cannot read source root ${root}`);
  }
}

main();
