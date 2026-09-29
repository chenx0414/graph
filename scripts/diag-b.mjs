/**
 * diag-b - read-only source size and module directory distribution.
 *
 * Answers "how big is each src/<module> area, and where does the bulk sit?" without touching the
 * working tree: it walks `src/`, groups files by their top-level module directory (src/core,
 * src/runtime, src/web, ...) and prints a summary of file count, line count and bytes per module,
 * plus the largest files.
 *
 * Read-only by construction - it only uses `node:fs` reads and never writes, and it imports nothing
 * outside the Node builtins. It is a diagnostic, not a check: it always exits 0.
 *
 * Run: node scripts/diag-b.mjs [root]   (root defaults to the repository's src/)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/** Extensions treated as countable source. Anything else (images, fonts) is skipped, not guessed. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.css', '.html', '.json', '.md']);
/** Directories never walked even if they appear under src/. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'src');

/** Count lines the way an editor does: a trailing newline terminates the last line, it does not add one. */
function countLines(content) {
  if (!content) return 0;
  const newlines = content.split('\n').length - 1;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/** Every countable file under `directory`, as repo-relative paths. */
function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) files.push(...collectFiles(join(directory, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(join(directory, entry.name));
  }
  return files;
}

/** The module bucket a path belongs to: `src/core/graph.ts` -> `src/core`; a loose `src/x.ts` -> `src`. */
function moduleOf(file) {
  const segments = relative(repoRoot, file).split('/');
  return segments.length > 2 ? segments.slice(0, 2).join('/') : segments[0];
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

function main() {
  let names;
  try {
    names = statSync(sourceRoot).isDirectory() ? collectFiles(sourceRoot) : [sourceRoot];
  } catch {
    console.error(`diag-b: cannot read source root ${sourceRoot}`);
    process.exitCode = 0;
    return;
  }

  const modules = new Map();
  const extensions = new Map();
  const files = [];

  for (const file of names) {
    const content = readFileSync(file, 'utf8');
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

    files.push({ path: relative(repoRoot, file), lines, bytes });
  }

  const totals = files.reduce(
    (sum, file) => ({ files: sum.files + 1, lines: sum.lines + file.lines, bytes: sum.bytes + file.bytes }),
    { files: 0, lines: 0, bytes: 0 },
  );

  console.log(`diag-b - source size and module distribution (read-only)`);
  console.log(`root: ${sourceRoot}`);
  console.log(`source files: ${totals.files}, lines: ${totals.lines}, size: ${humanBytes(totals.bytes)}`);

  const moduleRows = [...modules.entries()]
    .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
    .map(([module, stats]) => [module, stats.files, stats.lines, humanBytes(stats.bytes), `${((stats.lines / totals.lines) * 100).toFixed(1)}%`]);
  moduleRows.push(['total', totals.files, totals.lines, humanBytes(totals.bytes), '100.0%']);
  printTable('By module directory', ['module', 'files', 'lines', 'size', 'share'], moduleRows);

  const extensionRows = [...extensions.entries()]
    .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
    .map(([extension, stats]) => [extension, stats.files, stats.lines]);
  printTable('By extension', ['ext', 'files', 'lines'], extensionRows);

  const largest = [...files].sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, 10);
  printTable('Largest files', ['file', 'lines', 'size'], largest.map(file => [file.path, file.lines, humanBytes(file.bytes)]));
}

main();
