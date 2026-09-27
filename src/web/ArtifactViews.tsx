/**
 * Shared artifact views: the compact list the right drawer hosts and the detail a
 * tab opens.
 *
 * Both read the same records the artifact workspace already serves, and the two
 * groups are what the drawer has to tell apart: what this task produced, and what
 * belongs to the project itself - promoted knowledge such as the harness backlog,
 * which no single task owns and which therefore has to stand on its own.
 */
import { useEffect, useState } from 'react';
import type { ArtifactRecord } from '../core/artifact-workspace.ts';
import { api } from './api.ts';
import { ArtifactPreview, type ArtifactContent } from './ArtifactWorkspace.tsx';
import { groupArtifacts } from './conversation-drawer.ts';
import { ErrorBox } from './shared.tsx';
import { Icon, Spinner } from './ui.tsx';

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 102 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ArtifactRow({ record, onOpenDetail }: { record: ArtifactRecord; onOpenDetail: (record: ArtifactRecord) => void }) {
  return (
    <li className="drawer-artifact-row" data-artifact={record.artifactId} data-version={record.version}>
      <button
        type="button"
        className="drawer-artifact-open"
        data-testid={`drawer-artifact-detail-${record.artifactId}-${record.version}`}
        onClick={() => onOpenDetail(record)}
      >
        <span className="grow truncate">
          <strong>{record.title ?? record.name}</strong>
          <span className="faint"> {record.namespace}/{record.name} · v{record.version} · {bytesLabel(record.size)}</span>
        </span>
        <Icon name="box" size={13} />
        <span>查看详情</span>
      </button>
    </li>
  );
}

function Group({ title, hint, records, onOpenDetail, testid }: {
  title: string;
  hint: string;
  records: readonly ArtifactRecord[];
  onOpenDetail: (record: ArtifactRecord) => void;
  testid: string;
}) {
  return (
    <section className="drawer-artifact-group" data-testid={testid}>
      <div className="drawer-section-head">
        <h3>{title}</h3>
        <span>{records.length} 个版本</span>
      </div>
      {records.length
        ? <ul className="list">{records.map(record => <ArtifactRow key={`${record.artifactId}:${record.version}`} record={record} onOpenDetail={onOpenDetail} />)}</ul>
        : <p className="muted" data-testid={`${testid}-empty`}>{hint}</p>}
    </section>
  );
}

/** The drawer's 「共享产物」 page: this entry's artifacts plus the project's own. */
export function ArtifactList({ records, loading, onOpenDetail }: {
  records: readonly ArtifactRecord[];
  loading?: boolean;
  onOpenDetail: (record: ArtifactRecord) => void;
}) {
  const groups = groupArtifacts(records);
  return (
    <div className="drawer-artifacts" data-testid="drawer-artifacts">
      {loading && <Spinner label="加载共享产物…" />}
      <Group
        testid="drawer-artifacts-own"
        title="本任务的产物"
        hint="这个任务还没有发布产物。"
        records={groups.own}
        onOpenDetail={onOpenDetail}
      />
      <Group
        testid="drawer-artifacts-project"
        title="不属于任何任务"
        hint="还没有提升到项目的产物。"
        records={groups.project}
        onOpenDetail={onOpenDetail}
      />
    </div>
  );
}

/**
 * One artifact in a tab of its own: the version, who produced it and its content.
 * The record is read through the task the user came from, which is the workspace
 * that may see it.
 */
export function ArtifactDetail({ taskId, artifactId, onTitle }: {
  taskId: string;
  artifactId: string;
  onTitle?: (title: string) => void;
}) {
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError('');
    void api<ArtifactRecord>(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`)
      .then(async record => {
        if (cancelled) return;
        onTitle?.(record.title ?? record.name);
        const body = await api<ArtifactContent>(
          `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/${record.version}/content`,
        );
        if (!cancelled) setContent(body);
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { cancelled = true; };
  }, [taskId, artifactId]);

  return (
    <div className="artifact-tab" data-testid="artifact-tab">
      {error && <ErrorBox message={`读取产物失败：${error}`} />}
      {!error && !content && <Spinner label="读取产物…" />}
      {content && <ArtifactPreview content={content} />}
    </div>
  );
}
