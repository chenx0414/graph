import type { DatabaseSync } from 'node:sqlite';

/**
 * Reclaiming space from the task database.
 *
 * The state database only ever grows: every streamed event, every per-operation
 * capability record and every context handoff stays forever, even after the task
 * that produced it finished. Nothing reads them again, because the console
 * rebuilds a finished task from its entries and its messages.
 *
 * The rules are deliberately conservative:
 * - a task with a worker actually running (`dispatched`) is never touched;
 * - a task whose newest event is younger than `minAgeMs` is never touched, so a
 *   conversation a user is watching cannot lose the stream being replayed;
 * - only rows beyond the newest N survive-anything window are dropped, which is
 *   what keeps the derived values intact: `MAX(timestamp)` per task (its
 *   updatedAt) and `MAX(version)` per task (the next handoff version) cannot move.
 */

export interface RetentionOptions {
  /** Wall clock in the same unit as the stored timestamps. */
  now: number;
  keepEventsPerTask: number;
  keepCapabilitiesPerNode: number;
  keepHandoffsPerOperation: number;
  /** A task whose newest event is younger than this is left alone. */
  minAgeMs: number;
}

export interface RetentionPlan {
  events: number;
  capabilities: number;
  handoffs: number;
  /** Approximate bytes the doomed event rows occupy. */
  bytes: number;
}

export type RetentionApplied = Omit<RetentionPlan, 'bytes'>;

/** The requirement history is small and is replayed by the console, so it always stays. */
const ALWAYS_KEEP_EVENTS = ['task.created', 'requirement.changed'];
/**
 * Only a dispatched operation means a worker is running right now. A `not_sent`
 * operation is not in flight: an abandoned batch leaves tens of thousands of them
 * behind, and they would otherwise pin the largest event streams forever. A task
 * whose turn is about to be sent is protected by recency instead, because its
 * newest event is seconds old.
 */
const IN_FLIGHT_STATES = ['dispatched'];

function integer(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function eligibleTaskSql(options: RetentionOptions): string {
  const cutoff = options.now - integer(options.minAgeMs, 'minAgeMs');
  const states = IN_FLIGHT_STATES.map(state => `'${state}'`).join(',');
  return `SELECT t.id FROM tasks t
      WHERE NOT EXISTS (SELECT 1 FROM operations o WHERE o.task_id = t.id AND o.state IN (${states}))
        AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id)
        AND (SELECT MAX(e.timestamp) FROM events e WHERE e.task_id = t.id) <= ${cutoff}`;
}

function rankSql(table: string, partition: string, order: string, idColumn: string, eligible: string): string {
  return `SELECT ${idColumn} AS id FROM (
      SELECT ${idColumn}, row_number() OVER (PARTITION BY ${partition} ORDER BY ${order} DESC) AS rank
      FROM ${table} WHERE task_id IN (${eligible})
    ) WHERE rank > `;
}

/** The single source of truth for what to delete; plan and apply both read it. */
function doomed(options: RetentionOptions) {
  const eligible = eligibleTaskSql(options);
  return {
    eligible,
    events: `SELECT cursor AS id, length(data) AS size FROM (
        SELECT cursor, data, type, row_number() OVER (PARTITION BY task_id ORDER BY cursor DESC) AS rank
        FROM events WHERE task_id IN (${eligible})
      ) WHERE rank > ${integer(options.keepEventsPerTask, 'keepEventsPerTask')}
        AND type NOT IN (${ALWAYS_KEEP_EVENTS.map(kind => `'${kind}'`).join(',')})`,
    capabilities: rankSql('node_capabilities', 'task_id, node_id', 'seq', 'seq', eligible) + integer(options.keepCapabilitiesPerNode, 'keepCapabilitiesPerNode'),
    handoffs: rankSql('context_handoffs', 'operation_id', 'version', 'id', eligible) + integer(options.keepHandoffsPerOperation, 'keepHandoffsPerOperation'),
  };
}

export function planRetention(db: DatabaseSync, options: RetentionOptions): RetentionPlan {
  const sql = doomed(options);
  const events = db.prepare(`SELECT count(*) AS rows, COALESCE(sum(size),0) AS bytes FROM (${sql.events})`).get() as { rows: number; bytes: number };
  const capabilities = db.prepare(`SELECT count(*) AS rows FROM (${sql.capabilities})`).get() as { rows: number };
  const handoffs = db.prepare(`SELECT count(*) AS rows FROM (${sql.handoffs})`).get() as { rows: number };
  return { events: events.rows, capabilities: capabilities.rows, handoffs: handoffs.rows, bytes: events.bytes };
}

export function applyRetention(db: DatabaseSync, options: RetentionOptions): RetentionApplied {
  const sql = doomed(options);
  db.exec('BEGIN IMMEDIATE');
  try {
    // The planning select carries the freed byte count as a second column, so the
    // id-only view is what the DELETE may consume.
    const events = db.prepare(`DELETE FROM events WHERE cursor IN (SELECT id FROM (${sql.events}))`).run();
    const capabilities = db.prepare(`DELETE FROM node_capabilities WHERE seq IN (${sql.capabilities})`).run();
    const handoffs = db.prepare(`DELETE FROM context_handoffs WHERE id IN (${sql.handoffs})`).run();
    db.exec('COMMIT');
    return { events: Number(events.changes), capabilities: Number(capabilities.changes), handoffs: Number(handoffs.changes) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
