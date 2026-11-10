import { TASK_LABEL } from './labels.ts';
import { Pill } from './ui.tsx';

export interface DrawerTask {
  id: string;
  request: string;
  status: string;
  projectId?: string;
  createdAt?: number;
}

const TASK_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  discussing: 'info', running: 'accent', queued: 'neutral', paused: 'warn', pausing: 'warn',
  blocked: 'warn', completed: 'success', failed: 'danger', skipped: 'neutral', abandoned: 'danger',
  awaiting_user: 'warn',
};

export function TaskDrawerSection({ tasks, selectedId, onSelect, origin }: {
  tasks: DrawerTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  origin: 'conversation' | 'workspace';
}) {
  const selected = tasks.find(task => task.id === selectedId) ?? tasks[0] ?? null;
  const visible = tasks.map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const byTime = (right.task.createdAt ?? right.index) - (left.task.createdAt ?? left.index) || right.index - left.index;
      return byTime;
    });
  return (
    <section className="drawer-all-tasks" data-testid={origin === 'conversation' ? 'conversation-tasks' : 'drawer-workspace-tasks'}>
      <div className="drawer-section-head"><h3>当前项目的图</h3><span>{tasks.length} 张</span></div>
      {tasks.length === 0 && (
        <div className="drawer-init-note" data-testid={origin === 'conversation' ? 'no-conversation-tasks' : 'drawer-workspace-empty'} data-panel="task-empty">
          <div className="thread-card-title">尚无功能任务</div>
          <div className="thread-card-copy">确认草稿后才会创建并开始执行。</div>
        </div>
      )}
      {tasks.length > 0 && (
        <nav className="drawer-task-nav" data-testid="drawer-task-nav" aria-label="全部任务">
          {visible.map(({ task }) => (
            <button key={task.id} type="button" className="drawer-task-nav-item"
              data-testid={origin === 'conversation' ? `conversation-task-${task.id}` : `drawer-workspace-task-${task.id}`}
              data-active={task.id === selected?.id} aria-pressed={task.id === selected?.id}
              onClick={() => { onSelect(task.id); location.hash = `#/tasks/${encodeURIComponent(task.id)}/graph`; }}>
              <span className="grow truncate" title={task.request}>{task.request}</span>
              <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
            </button>
          ))}
        </nav>
      )}
      <div className="drawer-task-detail" data-testid="drawer-task-detail">
        {!selected && <p className="muted" data-testid="no-task-graph">还没有任务；确认草稿后这里会显示它的窗口。</p>}
      </div>
    </section>
  );
}
