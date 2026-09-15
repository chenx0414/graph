/** Read-only projections for the console: run timeline, usage summary and
 * status tones. Pure functions so the labels and unknown-usage rules are
 * testable without a browser. */

export interface EventRow {
  cursor: number;
  type: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export type TimelineTone = 'info' | 'active' | 'success' | 'warn' | 'error';

export interface TimelineEntry {
  cursor: number;
  timestamp: number;
  type: string;
  label: string;
  detail?: string;
  nodeId?: string;
  tone: TimelineTone;
}

const EVENT_LABEL: Record<string, string> = {
  'task.created': '创建任务',
  'task.master_recovered': '恢复任务调度',
  'task.started': '开始执行',
  'task.completed': '任务完成',
  'task.pause_requested': '请求暂停',
  'task.resumed': '恢复执行',
  'requirement.changed': '需求更新',
  'proposal.created': '生成提案',
  'task.accepted': '确认提案',
  'operation.intent': '准备调用',
  'operation.dispatched': '发送调用',
  'operation.result': '调用完成',
  'operation.not_sent': '调用未发送',
  'operation.interrupted': '调用中断',
  'operation.unknown': '用量未知',
  'operation.reconciled': '核对完成',
  'operation.usage_reconciled': '用量核对',
  'operation.report_rejected': '回报被拒',
  'question.opened': '提出问题',
  'question.answered': '问题已答',
  'graph.revised': '图已修订',
  'graph.rework': '返工回边',
  'node.skipped': '节点跳过',
  'model.switched': '切换模型',
  'usage_unavailable': '用量不可用',
  'unknown_usage': '用量未知',
  'inactive_route': '非活跃路径',
};

const EVENT_TONE: Record<string, TimelineTone> = {
  'task.completed': 'success',
  'operation.result': 'success',
  'operation.dispatched': 'active',
  'operation.intent': 'active',
  'task.started': 'active',
  'operation.interrupted': 'warn',
  'operation.not_sent': 'warn',
  'operation.unknown': 'warn',
  'operation.report_rejected': 'warn',
  'question.opened': 'warn',
  'graph.rework': 'warn',
  'usage_unavailable': 'warn',
  'unknown_usage': 'warn',
  'inactive_route': 'warn',
};

function text(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function detailFor(event: EventRow): string | undefined {
  const data = event.data ?? {};
  switch (event.type) {
    case 'question.opened': {
      const kind = text(data, 'kind');
      const inner = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : {};
      const prompt = text(inner, 'prompt') ?? text(data, 'prompt');
      return [kind, prompt].filter(Boolean).join(' · ') || undefined;
    }
    case 'question.answered':
      return text(data, 'questionId');
    case 'operation.not_sent':
    case 'operation.report_rejected':
      return text(data, 'reason');
    case 'operation.interrupted': {
      const usage = data.usage;
      const usageLabel = usage === null ? '已知用量未结算' : typeof usage === 'number' ? `已结算 ${usage} tokens` : undefined;
      return [text(data, 'reason'), usageLabel].filter(Boolean).join(' · ') || undefined;
    }
    case 'operation.result': {
      const result = data.result && typeof data.result === 'object' ? data.result as { output?: unknown } : undefined;
      if (!result || result.output === undefined) return undefined;
      return truncate(typeof result.output === 'string' ? result.output : JSON.stringify(result.output));
    }
    case 'operation.intent':
    case 'operation.dispatched':
    case 'operation.unknown':
    case 'operation.reconciled':
    case 'operation.usage_reconciled':
    case 'graph.revised':
      return text(data, 'operationId') ?? text(data, 'reason');
    case 'graph.rework': {
      const to = data.to;
      return Array.isArray(to) && to.length ? `→ ${to.join(', ')}` : undefined;
    }
    case 'model.switched': {
      const from = text(data, 'from');
      const to = text(data, 'to');
      return from && to ? `${from} → ${to}` : undefined;
    }
    case 'task.accepted': {
      const branch = text(data, 'targetBranch');
      return branch ? `分支 ${branch}` : undefined;
    }
    case 'proposal.created': {
      const version = data.proposalVersion;
      return typeof version === 'number' ? `v${version}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Chronological, de-duplicated by cursor; the console renders newest first. */
export function buildTimeline(events: EventRow[]): TimelineEntry[] {
  const seen = new Set<number>();
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (!event || typeof event.cursor !== 'number' || !Number.isSafeInteger(event.cursor)) continue;
    if (seen.has(event.cursor)) continue;
    seen.add(event.cursor);
    const nodeId = text(event.data, 'nodeId');
    const detail = detailFor(event);
    entries.push({
      cursor: event.cursor,
      timestamp: event.timestamp,
      type: event.type,
      label: EVENT_LABEL[event.type] ?? event.type,
      tone: EVENT_TONE[event.type] ?? 'info',
      ...(nodeId ? { nodeId } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return entries.sort((left, right) => left.cursor - right.cursor);
}

export type NodeTone = 'pending' | 'active' | 'success' | 'error' | 'blocked';

export function nodeTone(status: string): NodeTone {
  switch (status) {
    case 'preparing':
    case 'running':
    case 'ready':
      return 'active';
    case 'succeeded':
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'blocked':
    case 'skipped':
      return 'blocked';
    default:
      return 'pending';
  }
}

export const NODE_TONE_COLOR: Record<NodeTone, string> = {
  pending: '#94a3b8',
  active: '#2563eb',
  success: '#16a34a',
  error: '#dc2626',
  blocked: '#d97706',
};

export interface UsageNode {
  id: string;
  status: string;
  used?: number | null;
  budget?: number | null;
  unlimited?: boolean;
}

export interface UsageSummary {
  used: number;
  budget: number;
  remaining: number | null;
  unlimited: boolean;
  measuredNodes: number;
  unknownNodes: number;
  unknownCost: boolean;
  cost: number | null;
}

/** Unknown usage is never folded to zero: it is counted separately and the
 * console shows it as 未知. */
export function summarizeUsage(nodes: UsageNode[], cost?: { unknown?: boolean; amount?: number | null; amounts?: Record<string, number> } | null): UsageSummary {
  let used = 0;
  let budget = 0;
  let measuredNodes = 0;
  let unknownNodes = 0;
  let hasBudget = false;
  let unlimited = false;
  for (const node of nodes) {
    if (typeof node.used === 'number' && Number.isFinite(node.used)) {
      used += node.used;
      measuredNodes += 1;
    } else {
      unknownNodes += 1;
    }
    if (node.unlimited === true) {
      // An unlimited node has no cap to sum or to divide against; the
      // remaining-budget figure must not pretend a finite one exists.
      unlimited = true;
    } else if (typeof node.budget === 'number' && Number.isFinite(node.budget)) {
      budget += node.budget;
      hasBudget = true;
    }
  }
  return {
    used,
    budget,
    remaining: !unlimited && hasBudget ? Math.max(0, budget - used) : null,
    unlimited,
    measuredNodes,
    unknownNodes,
    unknownCost: Boolean(cost?.unknown),
    cost: cost?.unknown ? null : cost?.amount ?? null,
  };
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return value.toLocaleString('en-US');
}

export function usageText(summary: UsageSummary): string {
  const parts = [`已计量 ${formatTokens(summary.used)} tokens`];
  if (summary.measuredNodes) parts.push(`${summary.measuredNodes} 个节点`);
  if (summary.unknownNodes) parts.push(`${summary.unknownNodes} 个节点用量未知`);
  if (summary.unlimited) parts.push('额度不限');
  else if (summary.remaining !== null) parts.push(`剩余预算 ${formatTokens(summary.remaining)} / ${formatTokens(summary.budget)}`);
  if (summary.unknownCost) parts.push('费用未知');
  else if (summary.cost !== null) parts.push(`费用 ${summary.cost}`);
  return parts.join(' · ');
}

export function openQuestionTotal(tasks: { openQuestions?: number }[]): number {
  return tasks.reduce((sum, task) => sum + (task.openQuestions ?? 0), 0);
}
