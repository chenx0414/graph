import { useState } from 'react';
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
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [statusFilter, setStatusFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const selected = tasks.find(task => task.id === selectedId) ?? tasks[0] ?? null;
  const statuses = [...new Set(tasks.map(task => task.status))];
  const projects = [...new Set(tasks.map(task => task.projectId).filter((id): id is string => Boolean(id)))];
  const visible = tasks.map((task, index) => ({ task, index }))
    .filter(({ task }) => (statusFilter === 'all' || task.status === statusFilter) && (projectFilter === 'all' || task.projectId === projectFilter))
    .sort((left, right) => {
      const byTime = (right.task.createdAt ?? right.index) - (left.task.createdAt ?? left.index) || right.index - left.index;
      return sort === 'newest' ? byTime : -byTime;
    });
  return (
    <section className="drawer-all-tasks" data-testid={origin === 'conversation' ? 'conversation-tasks' : 'drawer-workspace-tasks'}>
      <div className="drawer-section-head"><h3>当前项目的图</h3><span>{tasks.length} 张</span></div>
      {tasks.length > 0 && <div className="drawer-task-controls">
        <select aria-label="任务排序" data-testid="task-sort" value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
          <option value="newest">创建时间：新到旧</option><option value="oldest">创建时间：旧到新</option>
        </select>
        <select aria-label="筛选任务状态" data-testid="task-status-filter" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          <option value="all">全部状态</option>{statuses.map(status => <option key={status} value={status}>{TASK_LABEL[status] ?? status}</option>)}
        </select>
        {projects.length > 0 && <select aria-label="筛选项目" data-testid="task-project-filter" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
          <option value="all">全部项目</option>{projects.map(id => <option key={id} value={id}>{id}</option>)}
        </select>}
      </div>}
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
      {tasks.length > 0 && visible.length === 0 && <p className="muted">没有符合筛选条件的任务。</p>}
      <div className="drawer-task-detail" data-testid="drawer-task-detail">
        {!selected && <p className="muted" data-testid="no-task-graph">还没有任务；确认草稿后这里会显示它的窗口。</p>}
      </div>
    </section>
  );
}
