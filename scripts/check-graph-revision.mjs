#!/usr/bin/env node
/**
 * Host gate for the graph mechanism test (dynamic graph revision + real rework).
 *
 * This is a TEST of Graph itself, not a product check. It asserts four facts and
 * exits 1 with a printable reason as soon as any of them is false:
 *
 *   (a) docs/graph-revision-rework.md exists, has a `## 返工记录` section, and quotes
 *       the FIRST gate failure output verbatim (read from the settled `check` host
 *       operation record in the kernel state database - the same bytes the `rework`
 *       back-edge carried to the worker);
 *   (b) the document names the two free models that drive this graph:
 *       opencode-go:longcat-2.5-preview-free (implementer) and
 *       opencode-go:step-5-preview-free (reviewer);
 *   (c) the kernel state database shows >= 2 executions of node `worker` for this
 *       task - i.e. the rework back-edge really ran the worker again;
 *   (d) a revision > 1 exists whose added nodes have succeeded while the nodes it
 *       retired have no execution at all - i.e. main's mid-run graph revision really
 *       took effect.
 *
 * The gate never fabricates a pass: every fact is read from
 * ~/Library/Application Support/Graph/state/tasks.sqlite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MARKER = '[graph-revision]';
const DOC_REL = 'docs/graph-revision-rework.md';
const DOC_HEADING = '## 返工记录';
const MODEL_IMPLEMENTER = 'opencode-go:longcat-2.5-preview-free';
const MODEL_REVIEWER = 'opencode-go:step-5-preview-free';
const DB_PATH = join(homedir(), 'Library', 'Application Support', 'Graph', 'state', 'tasks.sqlite');
const CONTENT_PREFIX = 'graph-content:sha256:';
const ASSERTIONS = 4;

/** Resolve the task whose worktree contains the current directory. */
function resolveTaskId(db, cwd) {
  const rows = db.prepare('SELECT task_id, path FROM worktrees ORDER BY length(path) DESC').all();
  const hit = rows.find(row => typeof row.path === 'string' && (cwd === row.path || cwd.startsWith(`${row.path}/`)));
  return hit ? hit.task_id : null;
}

/** Kernel values <= 4 KiB are inline JSON; larger ones are content-addressed. */
function decodeStored(db, stored) {
  if (typeof stored !== 'string') return stored;
  if (!stored.startsWith(CONTENT_PREFIX)) return JSON.parse(stored);
  const digest = stored.slice(CONTENT_PREFIX.length);
  const row = db.prepare('SELECT body FROM kernel_content WHERE digest=?').get(digest);
  if (!row) throw new Error(`kernel_content ${digest} is missing`);
  return JSON.parse(row.body);
}

/** The earliest settled `check` host operation that failed, i.e. the first gate failure. */
function firstFailureOutput(db, taskId) {
  const rows = db.prepare(
    "SELECT result FROM kernel_module_operations WHERE task_id=? AND module_id='check' AND state='settled' ORDER BY created_at, rowid",
  ).all(taskId);
  for (const row of rows) {
    let evaluated;
    try {
      evaluated = decodeStored(db, row.result);
    } catch {
      continue;
    }
    const out = evaluated?.outputs?.result;
    if (!out || out.passed !== false) continue;
    return {
      code: out.code,
      stdout: typeof out.stdout === 'string' ? out.stdout : '',
      stderr: typeof out.stderr === 'string' ? out.stderr : '',
    };
  }
  return null;
}

const failureKeyLines = text =>
  [...new Set(text.split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith(`${MARKER} (`) && line.includes(') FAIL:')))];

function nodeStatus(db, taskId, nodeId) {
  const row = db.prepare('SELECT status FROM kernel_nodes WHERE task_id=? AND node_id=?').get(taskId, nodeId);
  return row?.status ?? 'absent';
}

function revisionNodeIds(db, taskId, version) {
  const row = db.prepare('SELECT definition FROM kernel_revisions WHERE task_id=? AND version=?').get(taskId, version);
  if (!row) return null;
  const definition = JSON.parse(row.definition);
  return Object.keys(definition.nodes ?? {});
}

function main() {
  const cwd = process.cwd();
  const problems = [];
  const notes = [];

  if (!existsSync(DB_PATH)) {
    console.log(`${MARKER} GATE FAIL — ${ASSERTIONS} assertions, 1 failed`);
    console.log(`${MARKER} (c) FAIL: state database not found: ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  try {
    const taskId = resolveTaskId(db, cwd);
    if (!taskId) {
      console.log(`${MARKER} GATE FAIL — ${ASSERTIONS} assertions, 1 failed`);
      console.log(`${MARKER} (c) FAIL: no task owns the worktree ${cwd}`);
      process.exit(1);
    }

    // (a) document + verbatim first failure output.
    const docPath = join(cwd, DOC_REL);
    const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : null;
    if (!doc) {
      problems.push({ key: 'a', detail: `${DOC_REL} is missing` });
    } else if (!doc.includes(DOC_HEADING)) {
      problems.push({ key: 'a', detail: `${DOC_REL} has no \`${DOC_HEADING}\` section` });
    }
    if (doc) {
      const first = firstFailureOutput(db, taskId);
      if (!first) {
        problems.push({ key: 'a', detail: 'no recorded first gate failure output yet' });
      } else {
        const keys = failureKeyLines(`${first.stdout}\n${first.stderr}`);
        if (keys.length === 0) {
          problems.push({ key: 'a', detail: 'recorded first gate failure output has no key lines' });
        } else {
          const missing = keys.filter(key => !doc.includes(key));
          if (missing.length) {
            problems.push({ key: 'a', detail: `${DOC_REL} does not quote the first failure verbatim: ${missing.join(' | ')}` });
          } else {
            notes.push(`first failure quoted verbatim (${keys.length} key line(s))`);
          }
        }
      }
    }

    // (b) both free model ids, as prose in the document.
    for (const [role, id] of [['implementer', MODEL_IMPLEMENTER], ['reviewer', MODEL_REVIEWER]]) {
      if (!doc || !doc.includes(id)) problems.push({ key: 'b', detail: `${DOC_REL} is missing ${role} free model id ${id}` });
    }
    if (doc?.includes(MODEL_IMPLEMENTER) && doc.includes(MODEL_REVIEWER)) notes.push('both free model ids documented');

    // (c) real rework: the worker ran at least twice.
    const workerExecutions = db.prepare(
      "SELECT COUNT(*) AS n FROM kernel_executions WHERE task_id=? AND node_id='worker'",
    ).get(taskId).n;
    if (workerExecutions < 2) {
      problems.push({ key: 'c', detail: `worker executions=${workerExecutions}, need >=2` });
    } else {
      notes.push(`worker executions=${workerExecutions}`);
    }

    // (d) main's mid-run revision took effect.
    const versions = db.prepare('SELECT version FROM kernel_revisions WHERE task_id=? ORDER BY version').all(taskId).map(row => row.version);
    const newest = versions.length ? Math.max(...versions) : 0;
    const baseNodes = revisionNodeIds(db, taskId, 1);
    if (newest <= 1 || !baseNodes) {
      problems.push({ key: 'd', detail: `no revision>1 (latest=${newest})` });
    } else {
      const currentNodes = revisionNodeIds(db, taskId, newest);
      const added = currentNodes.filter(node => !baseNodes.includes(node));
      const retired = baseNodes.filter(node => !currentNodes.includes(node));
      if (added.length === 0) {
        problems.push({ key: 'd', detail: `revision ${newest} added no node` });
      } else if (retired.length === 0) {
        problems.push({ key: 'd', detail: `revision ${newest} retired no node (notes should be retired)` });
      } else {
        const notSucceeded = added.filter(node => {
          const completed = db.prepare(
            "SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? AND state='completed' LIMIT 1",
          ).get(taskId, node);
          return nodeStatus(db, taskId, node) !== 'succeeded' && !completed;
        });
        const executedRetired = retired.filter(node =>
          db.prepare('SELECT 1 FROM kernel_executions WHERE task_id=? AND node_id=? LIMIT 1').get(taskId, node));
        if (notSucceeded.length) {
          const detail = notSucceeded.map(node => `${node} status=${nodeStatus(db, taskId, node)}`).join(', ');
          problems.push({ key: 'd', detail: `revision ${newest} added node ${detail}, need succeeded` });
        } else if (executedRetired.length) {
          problems.push({ key: 'd', detail: `retired node ${executedRetired.join(', ')} has executions` });
        } else {
          notes.push(`revision ${newest}: added ${added.join(', ')} succeeded; retired ${retired.join(', ')} never ran`);
        }
      }
    }

    if (problems.length) {
      console.log(`${MARKER} GATE FAIL — ${ASSERTIONS} assertions, ${problems.length} failed`);
      for (const problem of problems) console.log(`${MARKER} (${problem.key}) FAIL: ${problem.detail}`);
      console.log(`${MARKER} task ${taskId}`);
      process.exit(1);
    }
    console.log(`${MARKER} GATE PASS — ${ASSERTIONS}/4 assertions`);
    for (const note of notes) console.log(`${MARKER} ok: ${note}`);
    console.log(`${MARKER} task ${taskId}`);
  } finally {
    db.close();
  }
}

main();
