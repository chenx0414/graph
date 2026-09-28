import { costText, formatTokens } from './format.ts';
import { formatDuration } from '../core/task-summary.ts';

/** The one task fact the card needs; the conversation view already carries all of it. */
export interface CardTask {
  id: string;
  request: string;
  phase: string;
  status: string;
  integrationSha: string | null;
  targetBranch: string | null;
  cost: { unknown?: boolean; amount?: number | null; amounts?: Record<string, number> };
  nodes: { id: string; status: string; used?: number | null }[];
  evidence: { acceptanceId: string; valid: boolean }[];
}

export interface TaskCard {
  taskId: string;
  request: string;
  /** `delivered` needs both a completed phase and a sha to hand over; anything else is not one. */
  outcome: 'delivered' | 'stopped' | 'unfinished' | 'in_progress';
  outcomeLabel: string;
  usage: { tokens: number | null; tokensText: string; costText: string };
  nodes: { id: string; status: string }[];
  delivery: { integrationSha: string; targetBranch: string | null; acceptance: string[] } | null;
}

const LABEL: Record<TaskCard['outcome'], string> = {
  delivered: '已交付',
  stopped: '已中止',
  unfinished: '未交付',
  in_progress: '进行中',
};

/**
 * The end-of-task card, projected from the rows the console already has. Returns null while
 * the task is still running: a card is a report on something that ended, so there is nothing
 * to show yet rather than a half-written one.
 */
export function taskCard(task: CardTask): TaskCard | null {
  const ended = ['completed', 'abandoned', 'failed', 'retired', 'skipped'].includes(task.phase);
  if (!ended) return null;
  const delivered = task.phase === 'completed' && Boolean(task.integrationSha);
  const outcome: TaskCard['outcome'] = delivered ? 'delivered' : task.phase === 'abandoned' ? 'stopped' : 'unfinished';
  // Node usage is recorded per instance; a node that never reported leaves the total a floor,
  // so a missing number stays "unknown" rather than being read as zero.
  const measured = task.nodes.map(node => node.used).filter((used): used is number => typeof used === 'number');
  const tokens = measured.length > 0 ? measured.reduce((sum, used) => sum + used, 0) : null;
  return {
    taskId: task.id,
    request: task.request,
    outcome,
    outcomeLabel: LABEL[outcome],
    usage: { tokens, tokensText: formatTokens(tokens), costText: costText(task.cost) },
    nodes: task.nodes.map(node => ({ id: node.id, status: node.status })),
    delivery: delivered && task.integrationSha
      ? { integrationSha: task.integrationSha, targetBranch: task.targetBranch, acceptance: task.evidence.filter(item => item.valid).map(item => item.acceptanceId) }
      : null,
  };
}

export { formatDuration };
