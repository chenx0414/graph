export const TASK_LABEL: Record<string, string> = {
  discussing: '讨论中', chatting: '对话中', running: '执行中', queued: '排队中', paused: '已暂停', pausing: '暂停中',
  blocked: '等待处理', completed: '已完成', failed: '失败', skipped: '已跳过', executing: '执行中',
};

export const NODE_LABEL: Record<string, string> = {
  pending: '待执行', preparing: '执行中', succeeded: '已完成', failed: '失败', blocked: '被阻塞', skipped: '已跳过', ready: '就绪', running: '执行中',
};

export const QUESTION_LABEL: Record<string, string> = {
  waiting: '等待外部条件', human_check: '等待人工确认', reservation_exceeded: '预算不足',
  unknown_usage: '用量未知待核对', model_unavailable: '模型不可用', adapter_error: '适配器错误',
  execution_failed: '执行失败', git_conflict: 'Git 冲突', rework: '需要返工', stalled: '任务停滞',
  permission: '等待权限确认', budget: '预算不足', git_dirty: '工作区不干净', recovery: '结果不明待核查',
};

export function when(timestamp: number | null) {
  if (!timestamp) return '—';
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleString();
}

export function describeQuestion(kind: string) {
  return QUESTION_LABEL[kind] ?? kind;
}
