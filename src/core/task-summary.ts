import type { Json } from './types.ts';
import { sumCosts, type CostSummary } from '../catalog/models.ts';
import { invocationRows } from '../runtime/task-gate.ts';
import type { TaskStore } from './store.ts';

/**
 * What a finished task amounts to, assembled from records that already exist.
 *
 * Nothing here is a new measurement: run time comes from the task's own event clock,
 * tokens and cost from its recorded invocations, the result from its phase plus the
 * delivered sha and the acceptance evidence that passed. The card is only a reading of
 * the ledger, so it can never disagree with it.
 */
export interface TaskSummaryNode {
  id: string;
  status: string;
}

export interface TaskSummaryUsage {
  /** Recorded tokens across every invocation, or undefined when nothing was recorded. */
  tokens?: number;
  /** True when some invocation ran but its usage was not recorded: the total is a floor. */
  unknownUsage: boolean;
  cost: CostSummary;
}

export interface TaskSummaryDelivery {
  integrationSha: string;
  targetBranch?: string;
  acceptance: { id: string; valid: boolean }[];
}

export interface TaskSummary {
  taskId: string;
  request: string;
  status: string;
  /**
   * `delivered` only when the task completed and left a sha to hand over. Stopping a task
   * is an ending too, but calling it a delivery would be a claim the card cannot walk back.
   */
  outcome: 'delivered' | 'abandoned' | 'in_progress' | 'unfinished';
  startedAt?: number;
  endedAt?: number;
  /** Wall clock between the first and last recorded event; omitted while the task is open. */
  durationMs?: number;
  usage: TaskSummaryUsage | null;
  nodes: TaskSummaryNode[];
  delivery: TaskSummaryDelivery | null;
}

const TERMINAL = new Set(['succeeded', 'skipped', 'retired', 'failed', 'abandoned']);
const ENDING_TYPES = ['task.completed', 'task.abandoned'];

/**
 * The task's own event clock. The first event is the start; an end exists only once the
 * task actually reached one, so a running task reports no duration instead of a number
 * that keeps changing between reads.
 */
function clock(store: TaskStore, taskId: string): { startedAt?: number; endedAt?: number } {
  const first = store.db.prepare('SELECT MIN(timestamp) AS at FROM events WHERE task_id=?').get(taskId) as { at: number | null } | undefined;
  const last = store.db.prepare(`SELECT MAX(timestamp) AS at FROM events WHERE task_id=? AND type IN (${ENDING_TYPES.map(() => '?').join(',')})`)
    .get(taskId, ...ENDING_TYPES) as { at: number | null } | undefined;
  return {
    ...(first?.at != null ? { startedAt: first.at } : {}),
    ...(last?.at != null ? { endedAt: last.at } : {}),
  };
}

function usageOf(store: TaskStore, taskId: string): TaskSummaryUsage | null {
  const invocations = invocationRows(store, taskId);
  if (invocations.length === 0) return null;
  let tokens: number | undefined;
  let unknownUsage = false;
  for (const item of invocations) {
    if (!item.usage) { unknownUsage = true; continue; }
    const { input, output, cacheRead, cacheWrite } = item.usage;
    tokens = (tokens ?? 0) + (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  return {
    ...(tokens === undefined ? {} : { tokens }),
    unknownUsage: unknownUsage && tokens === undefined ? true : unknownUsage,
    cost: sumCosts(invocations.map(item => item.cost as Json | null | undefined)),
  };
}

function nodesOf(store: TaskStore, taskId: string): TaskSummaryNode[] {
  const rows = store.db.prepare('SELECT id,status FROM nodes WHERE task_id=? ORDER BY rowid').all(taskId) as { id: string; status: string }[];
  return rows.map(row => ({ id: row.id, status: row.status }));
}

function deliveryOf(store: TaskStore, taskId: string, phase: string): TaskSummaryDelivery | null {
  const task = store.db.prepare('SELECT integration_sha,target_branch FROM tasks WHERE id=?').get(taskId) as { integration_sha: string | null; target_branch: string | null } | undefined;
  // Only a completed task with a handover sha is a delivery; a stopped task keeps no receipt.
  if (phase !== 'completed' || !task?.integration_sha) return null;
  const acceptance = store.db.prepare('SELECT acceptance_id,valid FROM evidence WHERE task_id=? AND acceptance_id IS NOT NULL ORDER BY rowid')
    .all(taskId) as { acceptance_id: string; valid: number }[];
  return {
    integrationSha: task.integration_sha,
    ...(task.target_branch ? { targetBranch: task.target_branch } : {}),
    acceptance: acceptance.filter(row => row.valid === 1).map(row => ({ id: row.acceptance_id, valid: true })),
  };
}

export function taskSummary(store: TaskStore, taskId: string): TaskSummary {
  const task = store.db.prepare('SELECT request,phase FROM tasks WHERE id=?').get(taskId) as { request: string; phase: string } | undefined;
  if (!task) throw new Error(`no task ${taskId}`);
  const { startedAt, endedAt } = clock(store, taskId);
  const delivery = deliveryOf(store, taskId, task.phase);
  const outcome: TaskSummary['outcome'] = task.phase === 'completed' && delivery
    ? 'delivered'
    : task.phase === 'abandoned'
      ? 'abandoned'
      : TERMINAL.has(task.phase) ? 'unfinished' : 'in_progress';
  return {
    taskId,
    request: task.request,
    status: task.phase,
    outcome,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(startedAt === undefined || endedAt === undefined ? {} : { durationMs: Math.max(0, endedAt - startedAt) }),
    usage: usageOf(store, taskId),
    nodes: nodesOf(store, taskId),
    delivery,
  };
}

/** Human-readable run time for a card: "1h 2m 3s", keeping the seconds that matter. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
