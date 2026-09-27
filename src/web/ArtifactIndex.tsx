/**
 * The shared-artifact index, as a window of its own.
 *
 * It answers one question: what has been published for this project, and what of that belongs to
 * the project itself rather than to one task. The drawer only links here; a single artifact opens in
 * its own tab.
 */
import { useEffect, useState } from 'react';
import type { ArtifactRecord } from '../core/artifact-workspace.ts';
import { api } from './api.ts';
import { ArtifactList } from './ArtifactViews.tsx';
import { ErrorBox } from './shared.tsx';

type Page = { artifacts: ArtifactRecord[] };

export function ArtifactIndex({ projectId, projects }: { projectId: string; projects: { id: string }[] }) {
  const [chosen, setChosen] = useState(projectId);
  const [records, setRecords] = useState<ArtifactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setChosen(projectId); }, [projectId]);
  useEffect(() => {
    if (!chosen) { setRecords([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        // One query answers it: what the project owns plus what its tasks published, every
        // version of each, newest first.
        const page = await api<Page>(`/api/projects/${encodeURIComponent(chosen)}/artifacts?include=task&latestOnly=false&limit=200`);
        if (!cancelled) {
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

  return (
    <div className="stagger" data-testid="artifact-index">
      <div className="row-between" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>共享产物</h1>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">项目</span>
          <select className="select" data-testid="artifact-index-project" value={chosen} onChange={event => setChosen(event.target.value)}>
            {projects.map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
          </select>
        </label>
      </div>
      {error && <ErrorBox message={`读取共享产物失败：${error}`} />}
      <ArtifactList
        records={records}
        loading={loading}
        onOpenDetail={record => { location.hash = `#/tasks/${record.taskId}/artifacts/${record.artifactId}?v=${record.version}`; }}
      />
    </div>
  );
}
