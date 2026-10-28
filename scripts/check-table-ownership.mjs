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
 *   node scripts/check-table-ownership.mjs --staged  # only what the change adds
 *
 * The staged mode is the one that can run in every worktree's commit hook:
 * it refuses a change that adds a writer for a table that already has one,
 * and leaves the tables whose owner this branch has not reached yet alone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(REPO_ROOT, 'backend', 'internal', 'graph');

/** The exemption a file has to declare at its top. */
const EXEMPT = 'graph:table-writes-exempt:';

/** The tables each store owns, and the file that owns each one. */
const OWNED = new Map([
  // The task store owns the v1 tables.
  ['tasks', 'core_task_lifecycle.go'],
  ['project_archive_pauses', 'core_task_lifecycle.go'],
  ['graph_preparation_pauses', 'core_task_lifecycle.go'],
  ['questions', 'core_task_questions.go'],
  ['node_questions', 'core_node_questions.go'],
  ['invocations', 'core_task_invocations.go'],
  ['nodes', 'core_task_nodes.go'],
  ['activations', 'core_task_activations.go'],
  ['instances', 'core_task_instances.go'],
  ['operations', 'core_task_operations.go'],
  ['conversations', 'core_task_conversations.go'],
  ['work_requests', 'core_task_work_requests.go'],
  ['work_request_revisions', 'core_task_work_requests.go'],
  ['work_graphs', 'core_task_work_graphs.go'],
  ['work_drafts', 'core_task_work_drafts.go'],
  ['proposals', 'core_task_proposals.go'],
  ['messages', 'core_task_messages.go'],
  // A module may own a table of its own. These were already written by one
  // file each, so the rule is already true of them - saying so keeps it
  // true, and names who the owner is.
  ['budget_scopes', 'core_budget_ledger.go'],
  ['wake_intents', 'core_wake_ledger.go'],
  ['rsi_continuations', 'core_rsi_continuation.go'],
  ['pause_continuations', 'core_pause_continuation.go'],
  ['tool_calls', 'core_store_tool_calls.go'],
  ['tool_call_spools', 'core_store_tool_calls.go'],
  ['agent_context_bindings', 'core_context.go'],
  ['git_commits', 'git_integration_commit.go'],
  ['git_ops', 'core_git_operations.go'],
  ['worktrees', 'core_git_operations.go'],
  ['runtime', 'core_task_runtime_state.go'],
  ['projects', 'core_task_projects.go'],
  ['artifacts', 'core_artifact_rows.go'],
  ['artifact_links', 'core_artifact_rows.go'],
  ['context_handoffs', 'core_context.go'],
  ['commands', 'core_store_events.go'],
  ['task_grants', 'core_task_grants.go'],
  // The tables one file has always written by itself.
  ['artifact_events', 'core_artifact_storage.go'],
  ['context_resolutions', 'core_context.go'],
  ['conversation_acceptances', 'core_task_runtime_conversation_confirm.go'],
  ['conversation_streams', 'core_conversation_activity.go'],
  ['definitions', 'catalog_catalog.go'],
  ['events', 'core_store_events.go'],
  ['models', 'core_task_runtime_open.go'],
  ['node_capabilities', 'core_node_capabilities.go'],
  ['node_entries', 'core_node_entries.go'],
  ['node_sessions', 'core_node_capabilities.go'],
  ['node_write_captures', 'core_write_ledger.go'],
  ['presets', 'catalog_catalog.go'],
  ['project_preparation', 'git_integration_prepare.go'],
]);

/**
 * The tables the schema declares.
 *
 * A table that is not in the schema is not the database's business: SQLite
 * keeps tables of its own, and a statement that names one of those is not
 * a write this rule has an opinion about.
 */
const SCHEMA_FILES = ['core_store_schema_base.go', 'core_store_schema.go', 'core_store_migrate.go'];
const SCHEMA_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)\s*\(/gi;

function schemaTables() {
  const tables = new Set();
  for (const name of SCHEMA_FILES) {
    let source;
    try {
      source = readFileSync(join(PACKAGE, name), 'utf8');
    } catch {
      continue;
    }
    SCHEMA_TABLE.lastIndex = 0;
    let match;
    while ((match = SCHEMA_TABLE.exec(source)) !== null) tables.add(match[1]);
  }
  return tables;
}

/** The kernel tables are owned by the store's own files. */
const KERNEL_OWNER = /^core_kernel_/;

/**
 * A write to an owned table.
 *
 * The SQL lives in Go string literals, and a statement may be written across
 * several lines, so the pattern allows whitespace between the verb and the
 * table name.
 */
const WRITE = /(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+[`"']?([a-z_]+)/gi;

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

/**
 * Whether a file may write a table.
 *
 * A table the schema declares needs a named owner, and only that owner
 * writes it. A table with no owner yet is the one case this refuses
 * outright: a new table has to be given one before it is written.
 */
function ownsIt(name, table, declared) {
  if (table.startsWith('kernel_')) return KERNEL_OWNER.test(name);
  const owner = OWNED.get(table);
  if (owner === undefined) return !declared.has(table);
  return owner === name;
}

function goFilesIn(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.go'))
    .map((name) => join(directory, name));
}

/**
 * The writes the staged change adds, with the file they are in.
 *
 * Only what is added is looked at. A table whose owner this branch has not
 * reached yet is still written from several places in the tree, and a change
 * that does not touch those places is not what made it so. What the check
 * refuses is a change that adds a new writer for a table that already has
 * one.
 */
function stagedWrites() {
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0'], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return [];
  }
  const found = [];
  let file = '';
  diff.split('\n').forEach((line) => {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      return;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) return;
    const text = line.slice(1);
    if (!/(?:INSERT|UPDATE|DELETE)/i.test(text)) return;
    WRITE.lastIndex = 0;
    let match;
    while ((match = WRITE.exec(text)) !== null) {
      found.push({ file: resolve(REPO_ROOT, file), table: match[1], line: text.trim() });
    }
  });
  return found;
}

function report(offenders) {
  for (const offender of offenders) {
    console.error(
      `  ${relative(REPO_ROOT, offender.file)}: writes ${offender.table}`,
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const staged = args.includes('--staged');
  const given = args.filter((arg) => !arg.startsWith('--'));

  const offenders = [];
  const tables = new Set();
  const declared = schemaTables();

  if (staged) {
    for (const write of stagedWrites()) {
      const name = write.file.slice(write.file.lastIndexOf('/') + 1);
      if (ownsIt(name, write.table, declared)) continue;
      tables.add(write.table);
      offenders.push(write);
    }
  } else {
    const files = given.length > 0
      ? given.map((path) => resolve(REPO_ROOT, path))
      : goFilesIn(PACKAGE);
    for (const file of files) {
      if (!file.endsWith('.go')) continue;
      const source = readFileSync(file, 'utf8');
      if (source.includes(EXEMPT)) continue;
      const name = file.slice(file.lastIndexOf('/') + 1);
      for (const write of writesIn(source)) {
        if (ownsIt(name, write.table, declared)) continue;
        tables.add(write.table);
        offenders.push({ file, line: write.line, table: write.table });
      }
    }
  }

  if (offenders.length === 0) {
    const scope = staged ? 'the staged change' : given.length > 0 ? `${given.length} file(s)` : 'the package';
    console.log(`table ownership: ${scope} writes no owned table outside its owner`);
    return 0;
  }

  console.error('An owned table has more than one writer.');
  console.error('Its owner - a store, or the module it belongs to - is the only one that writes it.');
  console.error('');
  report(offenders);
  console.error('');
  console.error(`Tables written outside their owner: ${[...tables].sort().join(', ')}`);
  console.error('Move the write into the owner\'s method and call that.');
  console.error('A table the schema declares and nobody owns yet needs an owner named in this file.');
  console.error('A migration, or an operation that spans many tables at once, says so at the top:');
  console.error(`  // ${EXEMPT} <reason>`);
  return 1;
}

process.exit(main());
