


import { useCallback,useEffect,useState } from 'react';

import { api } from './api.ts';

import { usePreferences } from './preferences.ts';


import { Button,Card,Pill,Spinner,toast } from './ui.tsx';







import type { ProjectRow } from "./settings-config.tsx";

export function ProjectGitCard() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [archiving, setArchiving] = useState('');
  const load = useCallback(async () => {
    const data = await api<{ projects: ProjectRow[] }>('/api/settings');
    setProjects(data.projects.filter(project => !project.id.startsWith('conversation:')));
  }, []);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const prepare = async (project: ProjectRow, createBaseline: boolean) => {
    setBusy(project.id);
    try {
      const result = await api<{ state: string }>(`/api/projects/${encodeURIComponent(project.id)}/prepare`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `prepare-${project.id}-${crypto.randomUUID()}`, initialize: true, createBaseline }),
      });
      toast(result.state === 'ready' ? '项目基线已就绪' : '需要处理未提交修改', result.state === 'ready' ? 'success' : 'info');
    } catch (reason) {
      toast(`准备失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setBusy('');
      await load().catch(() => undefined);
    }
  };
  const setArchived = async (project: ProjectRow, action: 'archive' | 'restore') => {
    if (archiving) return;
    setArchiving(project.id);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `${action}-${project.id}-${crypto.randomUUID()}` }),
      });
      toast(action === 'archive'
        ? '项目已归档：未完成的工作已暂停，新的委派会被拒绝。'
        : '项目已恢复；归档时暂停的工作仍保持暂停，需要你明确要求继续。', 'success');
      window.dispatchEvent(new Event('graph:settings-changed'));
    } catch (reason) {
      toast(`${action === 'archive' ? '归档' : '恢复'}失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setArchiving('');
      await load().catch(() => undefined);
    }
  };
  const label = (state: string | undefined) => state === 'ready' ? '已准备' : state === 'detected' ? '待处理' : state === 'failed' ? '失败' : '未准备';
  const row = (project: ProjectRow, archived: boolean) => {
    const prep = project.preparation;
    const dirty = prep?.detail?.dirty ?? 0;
    return (
      <div className="list-item" key={project.id} data-testid={`git-project-${project.id}`} data-archived={archived}>
        <div className="row grow" style={{ alignItems: 'center' }}>
          {archived
            ? <Pill tone="neutral">已归档</Pill>
            : <Pill tone={prep?.state === 'ready' ? 'success' : prep?.state === 'failed' ? 'danger' : prep?.state === 'detected' ? 'warn' : 'neutral'}>{label(prep?.state)}</Pill>}
          <span className="grow">{project.id} <span className="muted">{project.root}</span></span>
          {!archived && prep?.projectSubdir && <span className="muted">子目录 {prep.projectSubdir}</span>}
          {!archived && prep?.baselineSha && <code className="faint">{prep.baselineSha.slice(0, 10)}</code>}
        </div>
        {!archived && prep?.state === 'detected' && <span className="muted">{dirty ? `${dirty} 项未提交修改；创建基线将把这些改动纳入本地快照` : prep.detail?.reason === 'not_a_repository' ? '尚未初始化 Git' : '需要准备'}</span>}
        {!archived && prep?.state === 'failed' && <span className="muted">{prep.detail?.reason ?? '准备失败'}</span>}
        <div className="row" style={{ gap: 8 }}>
          {!archived && prep?.state !== 'ready' && (
            <Button size="sm" data-testid={`git-prepare-${project.id}`} disabled={busy === project.id} onClick={() => void prepare(project, prep?.state === 'detected' && dirty > 0)}>
              {prep?.state === 'detected' && dirty > 0 ? '创建本地基线提交' : '准备 Git'}
            </Button>
          )}
          {archived
            ? <Button size="sm" icon="refresh" data-testid={`project-restore-${project.id}`} disabled={archiving === project.id} onClick={() => void setArchived(project, 'restore')}>{archiving === project.id ? '恢复中…' : '恢复项目'}</Button>
            : <Button size="sm" variant="danger" data-testid={`project-archive-${project.id}`} disabled={archiving === project.id} onClick={() => void setArchived(project, 'archive')}>{archiving === project.id ? '归档中…' : '归档项目'}</Button>}
        </div>
      </div>
    );
  };
  const active = (projects ?? []).filter(project => project.archivedAt == null);
  const archived = (projects ?? []).filter(project => project.archivedAt != null);
  return (
    <Card title="项目与本地基线" icon="box">
      {projects === null && <Spinner />}
      {projects?.length === 0 && <p className="muted">尚未配置项目。</p>}
      {active.map(project => row(project, false))}
      {archived.length > 0 && <div className="sidebar-label" data-testid="archived-projects-label">已归档项目（{archived.length}）</div>}
      {archived.map(project => row(project, true))}
    </Card>
  );
}

export type ArchivedConversation = {
  id: string; title: string; projectId: string | null; createdAt: number; archivedAt: number | null;
};

export function ArchivedConversations() {
  const [items, setItems] = useState<ArchivedConversation[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    const data = await api<ArchivedConversation[]>('/api/conversations?archived=true');
    setItems(data);
  }, []);
  useEffect(() => { void load().catch(() => setItems([])); }, [load]);
  async function restore(conversation: ArchivedConversation) {
    if (busy) return;
    setBusy(conversation.id);
    try {
      await api(`/api/conversations/${conversation.id}/unarchive`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `unarchive-${crypto.randomUUID()}` }),
      });
      toast('对话已取消归档并回到原项目。', 'success');
      window.dispatchEvent(new Event('graph:conversations-changed'));
      await load();
    } catch (reason) {
      toast(`取消归档失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setBusy('');
    }
  }
  return (
    <Card title="归档对话" icon="archive" subtitle="归档不会删除消息或任务记录；取消归档后会回到原来的项目">
      {items === null && <Spinner />}
      {items?.length === 0 && <p className="muted" data-testid="archived-empty">还没有归档对话。</p>}
      {items?.map(conversation => (
        <div className="list-item" key={conversation.id} data-testid={`archived-conversation-${conversation.id}`}>
          <div className="grow">
            <a href={`#/conversations/${conversation.id}`}>{conversation.title}</a>
            <div className="muted">
              {conversation.projectId ?? '未归属项目'}
              {conversation.archivedAt ? ` · 归档于 ${new Date(conversation.archivedAt).toLocaleString()}` : ''}
            </div>
          </div>
          <Button size="sm" icon="refresh" disabled={busy === conversation.id} onClick={() => void restore(conversation)}>
            {busy === conversation.id ? '恢复中…' : '取消归档'}
          </Button>
        </div>
      ))}
    </Card>
  );
}

export function RunningSourceCard({ source }: { source?: { root: string; commit: string | null; branch: string | null; dirty: boolean | null } | undefined }) {
  if (!source) return null;
  const commit = source.commit ? source.commit.slice(0, 12) : '未知';
  return (
    <Card
      title="运行中的代码"
      icon="box"
      testid="running-source"
    >
      <div className="chip-row">
        <Pill tone={source.commit ? 'info' : 'warn'}>
          <span>源码根：</span><span data-testid="source-root">{source.root}</span>
        </Pill>
        <Pill tone={source.commit ? 'info' : 'warn'}>
          <span>提交：</span><span data-testid="source-commit">{commit}</span>
        </Pill>
        {source.branch && <Pill tone="info"><span>分支：</span><span data-testid="source-branch">{source.branch}</span></Pill>}
        {source.dirty === true && <Pill tone="warn" testid="source-dirty">有未提交改动</Pill>}
      </div>
      {!source.commit && (
        <p className="muted" data-testid="source-unknown">
          这份运行代码不在 Git 检出里（打包应用或没有 git），因此没有提交号可显示。
        </p>
      )}
    </Card>
  );
}
