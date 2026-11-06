#!/usr/bin/env node
// What the agents' tool calls actually do, and why a call fails.
//
// The console shows a failure count per tool; a count is not an explanation. This
// script reads the live state store and prints the denominators (which roles, which
// window, how many calls), the failure rate per tool, the turn-level failures with
// their recorded reason, and one representative raw sample per top category. Run it
// after anything that changes tool policy, and keep its output as the evidence.
//
//   node scripts/tool-call-report.mjs [--state <dir>] [--days <n>] [--json]
//
// The state store is the daemon's own: ~/Library/Application Support/Graph/state on
// macOS. Nothing here writes.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const stateDir = flag('state', join(homedir(), 'Library', 'Application Support', 'Graph', 'state'));
const days = Number(flag('days', '30'));
const asJson = args.includes('--json');
const db = new DatabaseSync(join(stateDir, 'tasks.sqlite'), { readOnly: true });
const now = Date.now();
const since = now - days * 86_400_000;
const rows = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);
const pct = (part, whole) => (whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1));
const at = ms => new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ');

// One bucket per failure kind. The raw text is preserved in `sample`, because the
// classification is the part that can be wrong.
function classify(text) {
  const value = String(text ?? '');
  if (!value.trim()) return 'empty: no reason recorded';
  if (/没有完成回复|没有启动起来/.test(value) && !/原因/.test(value)) return 'turn failed with no reason recorded';
  if (/cut the arguments/.test(value)) return 'provider truncated the tool arguments';
  if (/unanswered|durable input was not answered/i.test(value)) return 'admitted input was never answered';
  if (/rate limit|429|50[234]|capacity|额度/i.test(value)) return 'provider capacity / rate limit';
  if (/invalid request|400|422|invalid_argument/i.test(value)) return 'provider rejected the request';
  if (/busy/i.test(value)) return 'conversation was busy';
  if (/Connection error|ECONNRESET|ETIMEDOUT|socket hang up/i.test(value)) return 'connection failed';
  if (/SIGKILL|exceeded the/i.test(value)) return 'process killed (resource limit)';
  if (/No credential bound|credential/i.test(value)) return 'credential missing';
  if (/Pi extension failed to load|extension/i.test(value)) return 'extension failed to load';
  if (/Pi process input is closed/.test(value)) return 'agent process already closed';
  if (/写成文本/.test(value)) return 'model wrote the tool call as text';
  if (/截断|truncated/i.test(value)) return 'model output was truncated';
  if (/打断|interrupt/i.test(value)) return 'turn was interrupted';
  return 'other';
}

const report = { state: stateDir, days, generatedAt: new Date(now).toISOString() };

// Denominators first: a rate without one is a number pretending to be a fact.
const span = one('SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*) AS total FROM tool_calls');
report.ledger = { first: at(span.first), last: at(span.last), calls: span.total };
report.window = { since: at(since), until: at(now) };
report.byRoleWindow = rows(
  `SELECT COALESCE(role,'(none)') AS role, COUNT(*) AS calls, SUM(is_error) AS failed
   FROM tool_calls WHERE created_at > ? GROUP BY role ORDER BY calls DESC`, since);
report.byRoleAllTime = rows(
  `SELECT COALESCE(role,'(none)') AS role, COUNT(*) AS calls, SUM(is_error) AS failed
   FROM tool_calls GROUP BY role ORDER BY calls DESC`);

// Per tool, in the window: where the failures actually are.
report.byToolWindow = rows(
  `SELECT tool, COUNT(*) AS calls, SUM(is_error) AS failed, ROUND(AVG(ms)) AS avgMs, MAX(ms) AS maxMs
   FROM tool_calls WHERE created_at > ? GROUP BY tool HAVING calls >= 10
   ORDER BY CAST(SUM(is_error) AS REAL) / COUNT(*) DESC, calls DESC`, since);

// The agent nodes themselves: the workflows the person was asking about.
report.byNodeWindow = rows(
  `SELECT node_id, role, COUNT(*) AS calls, SUM(is_error) AS failed
   FROM tool_calls WHERE created_at > ? AND role IN ('worker','reviewer')
   GROUP BY node_id, role HAVING calls >= 20 ORDER BY CAST(SUM(is_error) AS REAL) / COUNT(*) DESC`, since);
report.nodeTotals = rows(
  `SELECT role, COUNT(*) AS calls, SUM(is_error) AS failed,
          COUNT(DISTINCT node_id) AS nodes, COUNT(DISTINCT instance_id) AS instances
   FROM tool_calls WHERE created_at > ? AND role IN ('worker','reviewer') GROUP BY role`, since);

// Turn-level failures, grouped by what was recorded, so "no reason" is visible as
// its own category instead of hiding inside an aggregate.
const errorRows = rows(
  `SELECT text, created_at FROM messages WHERE kind='error' AND created_at > ?`, since);
const buckets = new Map();
for (const row of errorRows) {
  const name = classify(row.text);
  const bucket = buckets.get(name) ?? { category: name, messages: 0, first: row.created_at, last: row.created_at, sample: String(row.text).slice(0, 300) };
  bucket.messages += 1;
  bucket.first = Math.min(bucket.first, row.created_at);
  bucket.last = Math.max(bucket.last, row.created_at);
  buckets.set(name, bucket);
}
report.turnFailures = [...buckets.values()]
  .sort((a, b) => b.messages - a.messages)
  .map(bucket => ({ ...bucket, first: at(bucket.first), last: at(bucket.last) }));

// The same grouping over the whole history, because a single bad day can own the
// count a person sees.
const allErrors = rows(`SELECT text, created_at FROM messages WHERE kind='error'`);
const byDay = new Map();
for (const row of allErrors) {
  const day = new Date(Number(row.created_at)).toISOString().slice(0, 10);
  byDay.set(day, (byDay.get(day) ?? 0) + 1);
}
report.errorByDay = [...byDay.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1)).slice(0, 10)
  .map(([day, messages]) => ({ day, messages }));

// Turn-level denominators: how many turns succeeded in the window.
report.turns = one(
  `SELECT COUNT(*) AS assistantMessages FROM messages WHERE role='assistant' AND kind='chat' AND created_at > ?`, since);

// Node calls that failed and whose tool also failed elsewhere: which tools carry the
// node-side failures at all.
report.nodeToolFailures = rows(
  `SELECT tool, COUNT(*) AS failed FROM tool_calls
   WHERE created_at > ? AND role IN ('worker','reviewer') AND is_error=1 GROUP BY tool ORDER BY failed DESC`, since);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (label, value) => console.log(`${label.padEnd(34)} ${value}`);
  const table = (caption, list, columns) => {
    console.log(`\n${caption}`);
    console.log(columns.map(column => column.padEnd(16)).join(''));
    for (const item of list) console.log(columns.map(column => String(item[column] ?? '').padEnd(16)).join(''));
  };
  console.log(`state: ${report.state}`);
  console.log(`ledger: ${report.ledger.first} → ${report.ledger.last}, ${report.ledger.calls} recorded calls`);
  console.log(`window: last ${days} days (${report.window.since} → ${report.window.until})`);
  table('calls by role, this window', report.byRoleWindow.map(row => ({ ...row, failed: `${row.failed} (${pct(row.failed, row.calls)}%)` })), ['role', 'calls', 'failed']);
  table('calls by role, whole ledger', report.byRoleAllTime.map(row => ({ ...row, failed: `${row.failed} (${pct(row.failed, row.calls)}%)` })), ['role', 'calls', 'failed']);
  table('failure rate by tool, this window (>=10 calls)',
    report.byToolWindow.map(row => ({ tool: row.tool, calls: row.calls, failed: `${row.failed} (${pct(row.failed, row.calls)}%)`, avgMs: row.avgMs, maxMs: row.maxMs })),
    ['tool', 'calls', 'failed', 'avgMs', 'maxMs']);
  table('agent nodes with >=20 calls, this window, worst first',
    report.byNodeWindow.map(row => ({ node: `${row.node_id} (${row.role})`, calls: row.calls, failed: `${row.failed} (${pct(row.failed, row.calls)}%)` })),
    ['node', 'calls', 'failed']);
  table('node totals by role, this window',
    report.nodeTotals.map(row => ({ role: row.role, calls: row.calls, failed: `${row.failed} (${pct(row.failed, row.calls)}%)`, nodes: row.nodes, instances: row.instances })),
    ['role', 'calls', 'failed', 'nodes', 'instances']);
  line('assistant turns, this window', report.turns?.assistantMessages ?? 0);
  table('turn failures by recorded reason, this window',
    report.turnFailures.map(row => ({ category: row.category, messages: row.messages, first: row.first, last: row.last })), ['category', 'messages', 'first', 'last']);
  table('the 10 days that hold the most failures, whole history', report.errorByDay, ['day', 'messages']);
  table('node-side failures by tool, this window', report.nodeToolFailures, ['tool', 'failed']);
  if (report.turnFailures[0]) console.log(`\nlargest category sample:\n  ${report.turnFailures[0].sample}`);
}
