export const TASK_LABEL: Record<string, string> = {
  discussing: '讨论中', chatting: '对话中', running: '执行中', queued: '排队中', paused: '已暂停', pausing: '暂停中',
  blocked: '等待处理', completed: '已完成', failed: '失败', skipped: '已跳过', executing: '执行中', abandoned: '已终止',
  awaiting_user: '等你回答',
};

export const NODE_LABEL: Record<string, string> = {
  pending: '待执行', preparing: '执行中', succeeded: '已完成', failed: '失败', blocked: '被阻塞', skipped: '已跳过', ready: '就绪', running: '执行中',
};

export const QUESTION_LABEL: Record<string, string> = {
  waiting: '等待外部条件', human_check: '等待人工确认', reservation_exceeded: '预算不足',
  unknown_usage: '用量未知待核对', model_unavailable: '模型不可用', adapter_error: '适配器错误',
  context_rejected: '上下文请求被拒',
  execution_failed: '执行失败', git_conflict: 'Git 冲突', rework: '需要返工', stalled: '任务停滞',
  permission: '等待权限确认', git_dirty: '工作区不干净', recovery: '结果不明待核查',
  system_change: '系统优化待批准',
};

export function when(timestamp: number | null) {
  if (!timestamp) return '—';
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleString();
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function clockLabel(timestamp: number | null | undefined, now: number = Date.now()) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const reference = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === reference.toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  if (date.getFullYear() === reference.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

export function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds === 0) return '不到 1 秒';
  if (seconds < 60) return `耗时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `耗时 ${minutes} 分 ${rest} 秒` : `耗时 ${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `耗时 ${hours} 小时 ${restMinutes} 分` : `耗时 ${hours} 小时`;
}

export function describeQuestion(kind: string, data?: Record<string, unknown>) {
  if (kind === 'waiting' && data?.requestType === 'user_decision') return '等待你的决定';
  const label = QUESTION_LABEL[kind] ?? kind;
  if (typeof data?.escalatedAt === 'number') return `${label} · 无人处理`;
  return label;
}
