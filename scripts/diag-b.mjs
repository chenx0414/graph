#!/usr/bin/env node
// scripts/diag-b.mjs — read-only source-scale diagnostic.
//
// Walks a source tree (default: this repository's own src/) and reports, per
// module directory, how many source files and how many lines it holds, plus the
// overall totals and a short breakdown. Nothing is ever written: the script only
// reads and prints, so it is safe to run on a working tree at any time.
//
// Usage:
//   node scripts/diag-b.mjs                  # human-readable table
//   node scripts/diag-b.mjs --json           # the same numbers as JSON
//   node scripts/diag-b.mjs --target <dir>   # diagnose another source tree
//   node scripts/diag-b.mjs --help
//
// Only node builtins are imported; no dependency is added.

import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Code and markup count as source. Data (JSON snapshots), images and prose do
// not: src/catalog/models-dev.snapshot.json alone is several megabytes on a
// single line and would swamp every scale number.
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.mjs', '.cjs', '.jsx',
  '.css', '.scss', '.html',
]);

const LARGEST_FILES = 10;

function fail(message) {
  console.error(`diag-b: ${message}`);
  process.exit(1);
}

function usage() {
  return [
    'Usage: node scripts/diag-b.mjs [options]',
    '',
    'Report the size of a source tree per module directory (file count, lines, bytes).',
    'Read-only: the script reads files and prints a summary, it never writes.',
    '',
    'Options:',
    '  --json            print the numbers as JSON instead of a table',
    '  --target <dir>    source tree to measure (default: this repository\'s src/)',
    '  -h, --help        show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { json: false, help: false, target: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--target') {
      const value = argv[index + 1];
      if (value === undefined) fail('--target needs a directory argument');
      options.target = value;
      index += 1;
    } else {
      fail(`unknown argument: ${arg} (try --help)`);
    }
  }
  return options;
}

// Lines are counted the way an editor counts them: a trailing newline closes the
// last line instead of starting an empty one, and an empty file has no lines.
function countLines(text) {
  const newlines = text.match(/\n/g)?.length ?? 0;
  if (text === '' || text.endsWith('\n')) return newlines;
  return newlines + 1;
}

// Only real directories are descended into, so a symlink cycle can never make
// this walk loop forever, and symlinked entries are never counted twice.
async function collectFiles(dir) {
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

async function measure(target) {
  const files = await collectFiles(target);
  const rootName = basename(target);
  const modules = new Map();
  const extensions = new Map();
  const measured = [];
  let skipped = 0;

  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) {
      skipped += 1;
      continue;
    }
    const relative = file.slice(target.length + 1);
    const segments = relative.split('/');
    const module = segments.length > 1 ? segments[0] : rootName;

    const content = await readFile(file);
    const text = content.toString('utf8');
    const lines = countLines(text);
    const bytes = content.byteLength;

    const bucket = modules.get(module) ?? { name: module, files: 0, lines: 0, bytes: 0 };
    bucket.files += 1;
    bucket.lines += lines;
    bucket.bytes += bytes;
    modules.set(module, bucket);

    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    measured.push({ path: relative, lines, bytes });
  }

  const total = { files: 0, lines: 0, bytes: 0 };
  for (const bucket of modules.values()) {
    total.files += bucket.files;
    total.lines += bucket.lines;
    total.bytes += bucket.bytes;
  }

  const byLines = [...measured].sort((a, b) => (b.lines - a.lines) || (a.path < b.path ? -1 : 1));

  return {
    target,
    modules: [...modules.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    total,
    skipped,
    extensions: [...extensions.entries()]
      .map(([extension, count]) => ({ extension, files: count }))
      .sort((a, b) => (b.files - a.files) || (a.extension < b.extension ? -1 : 1)),
    largestFiles: byLines.slice(0, LARGEST_FILES),
  };
}

function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function table(report) {
  const nameWidth = Math.max('Module'.length, ...report.modules.map((m) => m.name.length));
  const rows = [
    ['Module', 'Files', 'Lines', 'Bytes'],
    ...report.modules.map((m) => [m.name, grouped(m.files), grouped(m.lines), grouped(m.bytes)]),
    ['TOTAL', grouped(report.total.files), grouped(report.total.lines), grouped(report.total.bytes)],
  ];

  const widths = [
    nameWidth,
    Math.max(...rows.map((row) => row[1].length)),
    Math.max(...rows.map((row) => row[2].length)),
    Math.max(...rows.map((row) => row[3].length)),
  ];
  const render = (row) => `  ${row[0].padEnd(widths[0])}  ${row[1].padStart(widths[1])}  ${row[2].padStart(widths[2])}  ${row[3].padStart(widths[3])}`;
  const rule = `  ${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}  ${'-'.repeat(widths[3])}`;

  const lines = [
    `Source scale of ${report.target}`,
    '',
    render(rows[0]),
    rule,
  ];
  for (const row of rows.slice(1, -1)) lines.push(render(row));
  lines.push(rule, render(rows.at(-1)), '');

  lines.push(`Extensions: ${report.extensions.map((e) => `${e.extension} ${grouped(e.files)}`).join('  ')}`);
  lines.push('Largest files:');
  for (const file of report.largestFiles) {
    lines.push(`  ${grouped(file.lines).padStart(7)}  ${file.path}`);
  }
  lines.push('', `${grouped(report.skipped)} non-source file(s) skipped.`);
  return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

// The module knows its own real path, so invoking this file through a symlink
// still measures the tree it lives in instead of silently reporting nothing.
const selfPath = realpathSync(fileURLToPath(import.meta.url));
const defaultTarget = join(dirname(dirname(selfPath)), 'src');
const target = resolve(options.target ?? defaultTarget);

let info;
try {
  info = await stat(target);
} catch {
  fail(`cannot read target: ${target}`);
}
if (!info.isDirectory()) fail(`target is not a directory: ${target}`);

const report = await measure(target);
console.log(options.json ? JSON.stringify(report, null, 2) : table(report));
