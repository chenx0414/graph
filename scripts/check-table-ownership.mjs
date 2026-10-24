#!/usr/bin/env node
/**
 * Guard: the tables a store owns have exactly one writer.
 *
 * The durable tables are split between two stores. The KernelStore owns the
 * kernel tables - the ones whose names start with `kernel_`. The TaskStore
 * owns the tasks, questions, invocations and nodes tables.
 *
 * A store that owns a table knows its shape: which column holds what, what
 * a row means, and which rules may write it. A write from anywhere else is
 * a second owner, and two owners mean a column that changes has to be
 * found in both places.
 *
 * Reading a table does not make a second owner of its shape, so reads are
 * allowed anywhere.
 *
 * Two kinds of file are exempt, and both have to say so at the top:
 *
 *   // graph:table-writes-exempt: <reason>
 *
 * A migration owns the SQL of the schema it migrates - that SQL describes
 * the shape itself and belongs where the shape is written down. An
 * operation that spans many tables at once - retiring a graph and
 * everything of it - is one fact about many tables, and splitting it would
 * make the operation lie about what it does.
 *
 * Usage:
 *   node scripts/check-table-ownership.mjs           # the whole package
 *   node scripts/check-table-ownership.mjs <path>...  # only those files
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(REPO_ROOT, 'backend', 'internal', 'graph');

/** The exemption a file has to declare at its top. */
const EXEMPT = 'graph:table-writes-exempt:';

/** The tables each store owns, and the file that owns each one. */
const OWNED = new Map([
  ['tasks', 'core_task_lifecycle.go'],
  ['questions', 'core_task_questions.go'],
  ['invocations', 'core_task_invocations.go'],
  ['nodes', 'core_task_nodes.go'],
  ['activations', 'core_task_activations.go'],
  ['instances', 'core_task_instances.go'],
]);

/** The kernel tables are owned by the store's own files. */
const KERNEL_OWNER = /^core_kernel_/;

/**
 * A write to an owned table.
 *
 * The SQL lives in Go string literals, and a statement may be written across
 * several lines, so the pattern allows whitespace between the verb and the
 * table name.
 */
const WRITE = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+[`"']?([a-z_]+)/gi;

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

/** The owned tables one file writes, with the line each write is on. */
function writesIn(source) {
  const found = [];
  const lines = withoutComments(source).split('\n');
  lines.forEach((line, index) => {
    WRITE.lastIndex = 0;
    let match;
    while ((match = WRITE.exec(line)) !== null) {
      const table = match[1];
      if (OWNED.has(table) || table.startsWith('kernel_')) {
        found.push({ table, line: index + 1 });
      }
    }
  });
  return found;
}

/** Whether a file owns the table it writes, or has said why it may. */
function ownsIt(name, table) {
  if (table.startsWith('kernel_')) return KERNEL_OWNER.test(name);
  return OWNED.get(table) === name;
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
    const source = readFileSync(file, 'utf8');
    if (source.includes(EXEMPT)) continue;
    const name = file.slice(file.lastIndexOf('/') + 1);
    for (const write of writesIn(source)) {
      if (ownsIt(name, write.table)) continue;
      tables.add(write.table);
      offenders.push({ file, line: write.line, table: write.table });
    }
  }

  if (offenders.length === 0) {
    const scope = given.length > 0 ? `${files.length} file(s)` : 'the package';
    console.log(`table ownership: ${scope} writes no owned table outside its owner`);
    return 0;
  }

  console.error('An owned table has more than one writer.');
  console.error('The store that owns it is the only one that writes it.');
  console.error('');
  report(offenders);
  console.error('');
  console.error(`Tables written outside their owner: ${[...tables].sort().join(', ')}`);
  console.error('Move the write into the owner\'s method and call that.');
  console.error('A migration, or an operation that spans many tables at once, says so at the top:');
  console.error(`  // ${EXEMPT} <reason>`);
  return 1;
}

process.exit(main());
