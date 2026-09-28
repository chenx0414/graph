import { TASK_LABEL } from './labels.ts';
import { costText } from './shared.tsx';
import { Icon, Pill } from './ui.tsx';

export interface DrawerTask {
  id: string;
  request: string;
  status: string;
  targetBranch?: string | null;
  integrationSha?: string | null;
  cost?: { unknown?: boolean; amount?: number };
}

const TASK_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  discussing: 'info', running: 'accent', queued: 'neutral', paused: 'warn', pausing: 'warn',
  blocked: 'warn', completed: 'success', failed: 'danger', skipped: 'neutral', abandoned: 'danger',
};

/** One task navigation surface for the conversation and every other workspace tab. */
export function TaskDrawerSection({ tasks, selectedId, onSelect, projectId, origin }: {
  tasks: DrawerTask[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  projectId: string | null;
  origin: 'conversation' | 'workspace';
}) {
  const selected = tasks.find(task => task.id === selectedId) ?? tasks[0] ?? null;
  const artifactsHref = `#/artifacts${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`;
  return (
    <section className="drawer-section drawer-all-tasks" data-testid={origin === 'conversation' ? 'conversation-tasks' : 'drawer-workspace-tasks'}>
      <div className="drawer-section-head"><h3>任务导航</h3><span>{tasks.length} 个任务</span></div>
      {tasks.length === 0 && (
        <div className="drawer-init-note" data-testid={origin === 'conversation' ? 'no-conversation-tasks' : 'drawer-workspace-empty'} data-panel="task-empty">
          <div className="thread-card-title">尚无功能任务</div>
          <div className="thread-card-copy">确认草稿后才会创建并开始执行。</div>
        </div>
      )}
      {tasks.length > 0 && (
        <nav className="drawer-task-nav" data-testid="drawer-task-nav" aria-label="全部任务">
          {tasks.map(task => (
            <button key={task.id} type="button" className="drawer-task-nav-item"
              data-testid={origin === 'conversation' ? `conversation-task-${task.id}` : `drawer-workspace-task-${task.id}`}
              data-active={task.id === selected?.id} aria-pressed={task.id === selected?.id}
              onClick={() => onSelect(task.id)}>
              <span className="grow truncate" title={task.request}>{task.request}</span>
              <Pill tone={TASK_TONE[task.status] ?? 'neutral'}>{TASK_LABEL[task.status] ?? task.status}</Pill>
            </button>
          ))}
        </nav>
      )}
      <div className="drawer-task-detail" data-testid="drawer-task-detail">
        {selected ? (
          <>
            <dl className="kv">
              <dt>状态</dt><dd>{TASK_LABEL[selected.status] ?? selected.status}</dd>
              {selected.targetBranch !== undefined && <><dt>目标分支</dt><dd>{selected.targetBranch ?? '未确认'}</dd></>}
              {selected.integrationSha !== undefined && <><dt>集成提交</dt><dd className="mono">{selected.integrationSha ?? '尚无'}</dd></>}
              {selected.cost && <><dt>费用</dt><dd>{costText(selected.cost)}</dd></>}
            </dl>
            <div className="drawer-entry-links" data-testid="drawer-entry-links">
              <a className="btn btn-sm" data-testid={`task-graph-tab-${selected.id}`} href={`#/tasks/${selected.id}/graph`}><Icon name="graph" size={14} /><span>任务图</span></a>
              <a className="btn btn-sm" data-testid="drawer-task-artifacts" href={artifactsHref}><Icon name="box" size={14} /><span>共享产物</span></a>
            </div>
          </>
        ) : (
          <>
            <p className="muted" data-testid="no-task-graph">还没有任务；确认草稿后这里会显示它的窗口。</p>
            <div className="drawer-entry-links" data-testid="drawer-entry-links">
              <a className="btn btn-sm" data-testid="drawer-task-artifacts" href={artifactsHref}><Icon name="box" size={14} /><span>共享产物</span></a>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
