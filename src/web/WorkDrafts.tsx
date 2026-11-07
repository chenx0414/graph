import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { defaultTargetBranch, type ProjectBranchView } from './project-branch.ts';
import { Button } from './ui.tsx';

type SupervisorRole = 'global' | 'project' | 'history' | 'legacy';
type Work = {
  id: string;
  conversationId: string;
  projectId: string | null;
  brief: string;
  revision: number;
  state: string;
  executionPaused: boolean;
};
type WorkDraft = {
  workId: string;
  version: number;
  workRevision: number;
  draftRevision: number;
  stale: boolean;
  proposal: { summary: string; acceptance: { id: string; description: string; checkNode: string }[]; definition: unknown };
};
type WorkGraph = {
  graphKey: string;
  version: number;
  workRevision: number;
  draftRevision: number;
  targetBranch: string | null;
  graphId: string | null;
  state: 'preparing' | 'ready' | 'blocked';
  reason: string | null;
};
type WorkView = { work: Work; drafts: WorkDraft[]; graphs: WorkGraph[] };
type PendingRequest = { graphKey: string; requestId: string; targetBranch: string | null };

function draftKey(draft: WorkDraft) {
  return `draft-${draft.version}-${draft.workRevision}-${draft.draftRevision}`;
}

export function WorkDrafts({ role, conversationId, projectId, projects, cursor }: {
  role: SupervisorRole | undefined;
  conversationId: string;
  projectId: string | null;
  projects: ProjectBranchView[];
  cursor: number;
}) {
  const [items, setItems] = useState<WorkView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Record<string, string>>({});
  const pending = useRef<Record<string, PendingRequest>>({});
  const sequence = useRef(0);
  const projectIDs = role === 'global' ? projects.map(project => project.id).sort().join('\u0000') : projectId ?? '';

  const refresh = useCallback(async () => {
    if (role !== 'project') return;
    const current = ++sequence.current;
    setLoading(true);
    try {
      const ids = projectIDs ? projectIDs.split('\u0000') : [];
      const pages = await Promise.all(ids.map(id => api<{ items: Work[] }>(`/api/orchestration/work?projectId=${encodeURIComponent(id)}`)));
      const work = pages.flatMap(page => page.items).filter(item => item.conversationId === conversationId);
      const next = await Promise.all(work.map(async item => {
        const [drafts, graphs] = await Promise.all([
          api<{ items: WorkDraft[] }>(`/api/orchestration/work/${encodeURIComponent(item.id)}/drafts`),
          api<{ items: WorkGraph[] }>(`/api/orchestration/work/${encodeURIComponent(item.id)}/graphs`),
        ]);
        return { work: item, drafts: drafts.items, graphs: graphs.items };
      }));
      if (sequence.current === current) { setItems(next); setError(''); }
    } catch (reason) {
      if (sequence.current === current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence.current === current) setLoading(false);
    }
  }, [conversationId, projectIDs, role]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 200);
    return () => { window.clearTimeout(timer); sequence.current += 1; };
  }, [refresh, cursor]);

  async function confirm(work: Work, draft: WorkDraft, previous: WorkGraph | undefined) {
    const key = `${work.id}:${draft.version}:${draft.workRevision}:${draft.draftRevision}`;
    const targetBranch = previous ? previous.targetBranch : ((branches[key] ?? defaultTargetBranch(projects, work.projectId) ?? '').trim() || null);
    let request = pending.current[key];
    if (!request || request.targetBranch !== targetBranch) {
      request = { graphKey: previous?.graphKey ?? draftKey(draft), requestId: crypto.randomUUID(), targetBranch };
      pending.current[key] = request;
    }
    setBusy(key);
    setError('');
    try {
      const receipt = await api<WorkGraph>(`/api/orchestration/work/${encodeURIComponent(work.id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: request.requestId,
          graphKey: request.graphKey,
          workRevision: draft.workRevision,
          version: draft.version,
          draftRevision: draft.draftRevision,
          targetBranch: request.targetBranch,
        }),
      });
      if (receipt.state === 'blocked') {
        setNotice(current => ({ ...current, [key]: `准备未完成：${receipt.reason ?? '请检查项目设置。'}` }));
      } else {
        setNotice(current => ({ ...current, [key]: '已确认草稿。任务图等待主管投递输入。' }));
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refresh();
    } finally {
      setBusy('');
    }
  }

  if (role !== 'project') return null;
  if (!items.some(item => item.drafts.length > 0)) {
    return error
      ? <section className="thread-card" data-testid="work-drafts" aria-label="工作草稿"><p role="alert">{error}</p></section>
      : null;
  }
  return (
    <section className="thread-card" data-testid="work-drafts" aria-label="工作草稿">
      <div className="thread-card-title">工作草稿</div>
      {error && <p role="alert">{error}</p>}
      {items.map(({ work, drafts, graphs }) => drafts.map(draft => {
        const key = `${work.id}:${draft.version}:${draft.workRevision}:${draft.draftRevision}`;
        const graph = graphs.find(item => item.version === draft.version && item.workRevision === draft.workRevision && item.draftRevision === draft.draftRevision);
        const stale = draft.stale || draft.workRevision !== work.revision;
        const disabled = stale || work.executionPaused || loading || Boolean(busy) || graph?.state === 'ready' || graph?.state === 'preparing';
        const branch = graph ? graph.targetBranch ?? '' : branches[key] ?? defaultTargetBranch(projects, work.projectId) ?? '';
        return (
          <article className="card" key={key} data-testid={`work-draft-${work.id}-${draft.version}`}>
            <div className="card-body">
              <div className="thread-card-title">{work.brief}</div>
              <p>{draft.proposal.summary}</p>
              <p className="muted">项目 {work.projectId ?? '未选择'} · 草稿 v{draft.version} · 工作修订 {draft.workRevision}</p>
              {stale && <p className="muted">工作内容已变化，请主管更新草稿。</p>}
              {work.executionPaused && <p className="muted">工作已暂停，继续后才能确认。</p>}
              <ul>{draft.proposal.acceptance.map(item => <li key={item.id}>{item.description}</li>)}</ul>
              <details><summary>查看任务图定义</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(draft.proposal.definition, null, 2)}</pre></details>
              <div className="thread-card-actions">
                <label>目标分支 <input className="input" value={branch} disabled={Boolean(graph)} onChange={event => setBranches(current => ({ ...current, [key]: event.target.value }))} placeholder="非代码任务可留空" /></label>
                <Button variant="primary" size="sm" disabled={disabled} onClick={() => void confirm(work, draft, graph)} data-testid={`confirm-work-${work.id}-${draft.version}`}>
                  {busy === key ? '正在确认…' : graph?.state === 'blocked' ? '重试准备' : graph?.state === 'ready' ? '已确认' : '确认草稿'}
                </Button>
                {graph?.graphId && <a href={`#/tasks/${encodeURIComponent(graph.graphId)}/graph`}>查看任务图</a>}
              </div>
              {(notice[key] || graph?.state === 'blocked') && <p role={graph?.state === 'blocked' ? 'alert' : undefined}>{notice[key] || `准备未完成：${graph?.reason ?? '请检查项目设置。'}`}</p>}
            </div>
          </article>
        );
      }))}
    </section>
  );
}
