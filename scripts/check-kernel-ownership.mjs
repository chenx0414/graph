#!/usr/bin/env node
/**
 * Guard: the kernel tables have exactly one writer.
 *
 * The kernel tables - the ones whose names start with `kernel_` - hold the
 * graph's durable state. The KernelStore owns them: it knows their shape,
 * and every other part of the daemon asks the store what it needs and tells
 * the store what to write.
 *
 * A write to one of those tables from anywhere else is a second owner. Two
 * owners mean the shape of the table is known in two places, and a column
 * that changes has to be found in both.
 *
 * The store's own files are `core_kernel_*.go`. Everything else in the
 * package may read the kernel tables - reading does not make a second owner
 * of the table's shape - but may not write them.
 *
 * Usage:
 *   node scripts/check-kernel-ownership.mjs           # the whole package
 *   node scripts/check-kernel-ownership.mjs <path>...  # only those files
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(REPO_ROOT, 'backend', 'internal', 'graph');

/** The files that own the kernel tables. */
const OWNER_PREFIX = 'core_kernel_';

/**
 * A write to a kernel table.
 *
 * The SQL lives in Go string literals, and a statement may be written across
 * several lines, so the pattern allows whitespace between the verb and the
 * table name.
 */
const WRITE = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+[`"']?(kernel_[a-z_]+)/gi;

/**
 * Removes comments, so a sentence about a table is not read as a statement
 * about it. Only whole-line comments are removed: a `//` inside a string
 * literal is part of the SQL, and cutting a line at it would hide the rest
 * of the statement.
 */
function withoutComments(source) {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The kernel tables one file writes, with the line each write is on. */
function writesIn(source) {
  const found = [];
  const lines = withoutComments(source).split('\n');
  lines.forEach((line, index) => {
    WRITE.lastIndex = 0;
    let match;
    while ((match = WRITE.exec(line)) !== null) {
      found.push({ table: match[1], line: index + 1 });
    }
  });
  return found;
}

function goFilesIn(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.go'))
    .map((name) => join(directory, name));
}

function report(offenders) {
  for (const offender of offenders) {
    console.error(
      `  ${relative(REPO_ROOT, offender.file)}:${offender.line} writes ${offender.table}`,
    );
  }
}

function main() {
  const given = process.argv.slice(2);
  const files = given.length > 0
    ? given.map((path) => resolve(REPO_ROOT, path))
    : goFilesIn(PACKAGE);

  const offenders = [];
  const tables = new Set();
  for (const file of files) {
    if (!file.endsWith('.go')) continue;
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (name.startsWith(OWNER_PREFIX)) continue;
    const source = readFileSync(file, 'utf8');
    for (const write of writesIn(source)) {
      tables.add(write.table);
      offenders.push({ file, line: write.line, table: write.table });
    }
  }

  if (offenders.length === 0) {
    const scope = given.length > 0 ? `${files.length} file(s)` : 'the package';
    console.log(`kernel ownership: ${scope} writes no kernel table outside the store`);
    return 0;
  }

  console.error('The kernel tables have more than one writer.');
  console.error('The store owns them; everything else asks the store.');
  console.error('');
  report(offenders);
  console.error('');
  console.error(`Tables written outside the store: ${[...tables].sort().join(', ')}`);
  console.error('Move the write into a KernelStore method and call that.');
  return 1;
}

process.exit(main());
