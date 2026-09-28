/**
 * The shared-artifact index, as a window of its own.
 *
 * It answers one question: what has been published for this project, and what of that belongs to
 * the project itself rather than to one task. The drawer only links here; a single artifact opens in
 * its own tab.
 */
import { useEffect, useRef, useState } from 'react';
import type { ArtifactRecord } from '../core/artifact-workspace.ts';
import { api } from './api.ts';
import { ArtifactList } from './ArtifactViews.tsx';
import { Button, Icon } from './ui.tsx';
import { ErrorBox } from './shared.tsx';

type Page = { artifacts: ArtifactRecord[]; nextCursor: string | null; total: number };

export function ArtifactIndex({ projectId, projects }: { projectId: string; projects: { id: string }[] }) {
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [moreLoading, setMoreLoading] = useState(false);
  const chosenRef = useRef(projectId);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const loadedProject = useRef<string | null>(null);
  const [chosen, setChosen] = useState(projectId);
  const [records, setRecords] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setChosen(projectId); }, [projectId]);
  chosenRef.current = chosen;
  useEffect(() => {
    if (!chosen) { setRecords([]); setNextCursor(null); setTotal(0); setError(''); setLoading(false); return; }
    let cancelled = false;
    if (loadedProject.current !== chosen) setRecords([]);
    setLoading(true);
    setError('');
    void (async () => {
      try {
        // Show one current version per document; details expose paginated history.
        const page = await api<Page>(`/api/projects/${encodeURIComponent(chosen)}/artifacts?include=task&latestOnly=true&limit=200`);
        if (!cancelled) {
          loadedProject.current = chosen;
          setNextCursor(page.nextCursor);
          setTotal(page.total);
          setRecords([...page.artifacts].sort((left, right) => right.createdAt - left.createdAt));
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [chosen]);

  async function loadMore() {
    if (!nextCursor || moreLoading) return;
    const project = chosen;
    setMoreLoading(true);
    try {
      const page = await api<Page>(`/api/projects/${encodeURIComponent(project)}/artifacts?include=task&latestOnly=true&limit=200&cursor=${encodeURIComponent(nextCursor)}`);
      if (chosenRef.current !== project) return;
      setRecords(current => [...current, ...page.artifacts.filter(record => !current.some(item => item.artifactId === record.artifactId))]);
      setNextCursor(page.nextCursor);
    } catch (reason) { if (chosenRef.current === project) setError(String(reason)); }
    finally { setMoreLoading(false); }
  }
  const filtered = records.filter(record =>
    (scope === 'all' || record.scope === scope) &&
    `${record.title ?? ''} ${record.namespace}/${record.name}`.toLowerCase().includes(search.toLowerCase().trim()));


  return (
    <div className="artifact-index" data-testid="artifact-index">
      <div className="artifact-index-heading">
        <div className="artifact-index-title"><Icon name="box" size={22} /><div><h1>共享产物</h1><p>浏览任务交付与项目知识，打开版本查看内容。</p></div></div>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">项目</span>
          <select className="select" data-testid="artifact-index-project" value={chosen} onChange={event => { setChosen(event.target.value); location.hash = `#/artifacts?project=${encodeURIComponent(event.target.value)}`; }}>
            {projects.map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
          </select>
        </label>
      </div>
      <div className="artifact-index-filters">
        <input className="input" type="search" aria-label="搜索共享产物" placeholder="搜索名称、标题或目录…" value={search} onChange={event => setSearch(event.target.value)} />
        <select className="select" aria-label="产物范围" value={scope} onChange={event => setScope(event.target.value)}>
          <option value="all">全部范围</option><option value="task">任务产物</option><option value="project">项目共享</option>
        </select>
        <span className="muted">{filtered.length} / {total} 份文档</span>
      </div>
      {error && <ErrorBox message={`读取共享产物失败：${error}`} />}
      {nextCursor && <Button size="sm" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? '加载中…' : '加载更多文档'}</Button>}
      <ArtifactList
        records={filtered}
        loading={loading}
        onOpenDetail={record => { location.hash = `#/tasks/${record.taskId}/artifacts/${record.artifactId}?v=${record.version}`; }}
      />
    </div>
  );
}
