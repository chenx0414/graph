import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What a prefix saving is worth on a real request sequence.
 *
 * A task does not pay for its context once. Every request carries the static
 * prefix plus everything the session said before it, so a byte saved in the
 * first turn is read again by every request that follows. This script rebuilds
 * one real conversation request by request and asks what the two changes are
 * worth when the saving is multiplied by the requests that read it.
 *
 * It is a calculation over a real ledger, not a measurement: no model is run.
 * The numbers it produces are the ones a real A/B on a production-shaped load
 * would have to confirm.
 *
 * Usage:
 *   node scripts/harness-prefix-counterfactual.mjs /path/to/tasks.sqlite \
 *     --conversation 3303 --task <task-id> [--static-bytes 62804] \
 *     [--rate 0.003] [--out /path/to/ledger.json]
 *
 * Environment:
 *   GRAPH_LEDGER_DB   the ledger to read when no path is given
 */

const options = { staticBytes: 62804, rate: 0.003, charsPerToken: 4 };
const positional = [];
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--conversation') options.conversation = Number(process.argv[++index]);
  else if (argument === '--task') options.task = process.argv[++index];
  else if (argument === '--static-bytes') options.staticBytes = Number(process.argv[++index]);
  else if (argument === '--rate') options.rate = Number(process.argv[++index]);
  else if (argument === '--out') options.out = process.argv[++index];
  else if (argument === '--help') {
    console.error('Usage: node scripts/harness-prefix-counterfactual.mjs /path/to/tasks.sqlite --conversation <id> --task <id>');
    process.exit(0);
  } else positional.push(argument);
}
const dbPath = positional[0] ?? process.env.GRAPH_LEDGER_DB;
if (!dbPath || options.conversation === undefined || !options.task) {
  console.error('Usage: node scripts/harness-prefix-counterfactual.mjs /path/to/tasks.sqlite --conversation <id> --task <task-id>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec('BEGIN'); // One consistent snapshot even while Graph is running.
  const rows = db.prepare('SELECT id, record FROM graph_durable_entries WHERE conversation_id=? ORDER BY commit_seq, id').all(options.conversation);
  const events = [];
  for (const row of rows) {
    let record;
    try { record = JSON.parse(row.record); } catch { continue; }
    for (const message of record.model ?? []) {
      let size = 0;
      if (typeof message.content === 'string') size = message.content.length;
      else if (Array.isArray(message.content)) for (const block of message.content) size += (block.text ?? '').length;
      if (message.role === 'assistant') events.push({ kind: 'request' });
      else if (message.role === 'toolResult') events.push({ kind: 'tool', size });
      else if (message.role === 'user') events.push({ kind: 'briefing', size });
    }
  }

  // The seam keeps a result that fits in the limit and replaces a bigger one
  // with its summary. The first two reads of a result are not summarised, and
  // the per-tool limits differ; both are left out here, so the number this
  // script produces is an upper bound on the saving.
  const seam = size => (size > 4000 ? 1024 : size);

  /**
   * Walk the request sequence and add up the context each request carries.
   *
   * The prefix of a request is the static prefix plus everything before it, so
   * the walk keeps what the session has carried so far and adds it to every
   * request it meets.
   */
  function walk({ withSeam, withSetupReuse }) {
    let carried = 0;
    let requests = 0;
    let total = 0;
    const seenBriefings = new Set();
    for (const event of events) {
      if (event.kind === 'request') {
        requests += 1;
        total += carried + options.staticBytes;
        continue;
      }
      if (event.kind === 'tool') {
        carried += withSeam ? seam(event.size) : event.size;
        continue;
      }
      // The task setup is sent again with every operation. Reuse keeps the
      // first copy and drops the ones that say the same thing.
      if (withSetupReuse && seenBriefings.has(event.size)) continue;
      seenBriefings.add(event.size);
      carried += event.size;
    }
    return { requests, total };
  }

  const baseline = walk({ withSeam: false, withSetupReuse: false });
  const ledgerOf = (sql, ...values) => db.prepare(sql).get(...values);
  const task = ledgerOf("SELECT COUNT(*) n, SUM(json_extract(i.usage,'$.cacheRead')) s FROM invocations i JOIN operations o ON o.id=i.operation_id WHERE o.task_id=?", options.task);
  const tree = ledgerOf("SELECT COUNT(*) n, SUM(json_extract(i.usage,'$.cacheRead')) s FROM invocations i JOIN operations o ON o.id=i.operation_id");

  const price = (label, run) => {
    const savedChars = baseline.total - run.total;
    const savedTokens = Math.round(savedChars / options.charsPerToken);
    // The saving per request, paid by every request of the real task.
    const scaledTokens = Math.round((savedChars / run.requests) * task.n / options.charsPerToken);
    return {
      label,
      sample: { requests: run.requests, savedTokens, savedFraction: savedChars / baseline.total },
      task: { requests: task.n, cacheReadTokens: task.s, savedTokens: scaledTokens, savedFraction: scaledTokens / task.s, savedUsd: scaledTokens / 1e6 * options.rate },
    };
  };

  const ledger = {
    schemaVersion: 1,
    caveats: [
      'This is a calculation over a real ledger, not a measurement: no model was run.',
      'The seam model keeps a result under 4000 characters and replaces a bigger one with a 1024 character summary; it ignores the per-tool limits and the rule that the first two reads of a result are not summarised, so it overstates the saving.',
      'The seam model assumes the model does not read the spilled file back. When it does, those bytes arrive as uncached input, which is priced far above a cached read, and the saving shrinks or reverses.',
      'The setup reuse model drops a briefing that repeats one already sent, comparing the briefings by size rather than by content.',
      'The static prefix is the size the real requests carried, entered as a parameter.',
      'The saving of one request is multiplied by the number of requests in the real task, which is where a per-request saving becomes a per-task saving.',
    ],
    source: { db: dbPath, conversationId: options.conversation, taskId: options.task, durableEntries: rows.length, events: events.length },
    assumptions: { staticPrefixChars: options.staticBytes, cachedReadUsdPerMillion: options.rate, charsPerToken: options.charsPerToken },
    sample: { requests: baseline.requests, contextChars: baseline.total, contextTokens: Math.round(baseline.total / options.charsPerToken) },
    task: { requests: task.n, cacheReadTokens: task.s, cacheReadUsd: task.s / 1e6 * options.rate },
    tree: { requests: tree.n, cacheReadTokens: tree.s, cacheReadUsd: tree.s / 1e6 * options.rate },
    variants: {
      seam: price('tool result seam', walk({ withSeam: true, withSetupReuse: false })),
      setupReuse: price('task setup reuse', walk({ withSeam: false, withSetupReuse: true })),
      both: price('both', walk({ withSeam: true, withSetupReuse: true })),
    },
  };
  const output = JSON.stringify(ledger, null, 2);
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, output + '\n');
    console.error(`[counterfactual] ledger written to ${options.out}`);
  }
  console.log(output);
  db.exec('COMMIT');
} finally { db.close(); }
