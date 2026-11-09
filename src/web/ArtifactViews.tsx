import { useEffect, useState, type ReactNode } from 'react';
import type { ArtifactRecord } from './kernel-view-types.ts';
import { api } from './api.ts';
import { groupArtifactsByTask } from './conversation-drawer.ts';
import { ErrorBox } from './shared.tsx';
import { Markdown } from './Markdown.tsx';
import { Icon, Spinner } from './ui.tsx';

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

function Group({ title, hint, records, onOpenDetail, testid, action }: {
  title: string;
  hint: string;
  records: readonly ArtifactRecord[];
  onOpenDetail: (record: ArtifactRecord) => void;
  testid: string;
  action?: ReactNode;
}) {
  return (
    <section className="drawer-artifact-group" data-testid={testid}>
      <div className="drawer-section-head">
        <h3>{title}</h3>
        <span className="drawer-artifact-group-meta">{action}{records.length} 份文档</span>
      </div>
      {records.length
        ? <ul className="list">{records.map(record => <ArtifactRow key={`${record.artifactId}:${record.version}`} record={record} onOpenDetail={onOpenDetail} />)}</ul>
        : <p className="muted" data-testid={`${testid}-empty`}>{hint}</p>}
    </section>
  );
}

export function ArtifactList({ records, loading, onOpenDetail, tasks, variant = 'rows' }: {
  records: readonly ArtifactRecord[];
  loading?: boolean;
  onOpenDetail: (record: ArtifactRecord) => void;
  tasks?: readonly { id: string; request: string }[];
  variant?: 'rows' | 'cards';
}) {
  const groups = groupArtifactsByTask(records, tasks ?? []);
  if (variant === 'cards') {
    return (
      <div className="drawer-artifacts artifact-cards" data-testid="artifact-cards">
        {loading && <Spinner label="加载共享产物…" />}
        {records.length
          ? <ul className="list">{records.map(record => <ArtifactRow key={`${record.artifactId}:${record.version}`} record={record} onOpenDetail={onOpenDetail} />)}</ul>
          : <p className="muted" data-testid="artifact-cards-empty">还没有任务图发布过产物。</p>}
      </div>
    );
  }
  return (
    <div className="drawer-artifacts" data-testid="drawer-artifacts">
      {loading && <Spinner label="加载共享产物…" />}
      <div className="drawer-artifact-graphs" data-testid="drawer-artifacts-own">
        {groups.graphs.length
          ? groups.graphs.map(group => (
            <Group
              key={group.taskId}
              testid={`drawer-artifacts-graph-${group.taskId}`}
              title={`任务图 · ${group.request}`}
              hint="这个任务图还没有发布过产物。"
              records={group.records}
              onOpenDetail={onOpenDetail}
              action={<a className="drawer-artifact-graph-link" href={`#/tasks/${encodeURIComponent(group.taskId)}/graph`}><Icon name="graph" size={12} />任务图</a>}
            />
          ))
          : <p className="muted" data-testid="drawer-artifacts-own-empty">还没有任务图发布过产物。</p>}
      </div>
      <Group
        testid="drawer-artifacts-project"
        title="项目共享 · 不属于任何任务"
        hint="还没有提升到项目的产物。"
        records={groups.project}
        onOpenDetail={onOpenDetail}
      />
    </div>
  );
}

export function ArtifactDetail({ taskId, artifactId, version, onTitle }: {
  taskId: string;
  artifactId: string;
  version?: number;
  onTitle?: (title: string) => void;
}) {
  const [versions, setVersions] = useState<ArtifactRecord[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionsCursor, setVersionsCursor] = useState<string | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  async function loadVersions(cursor?: string) {
    if (versionsLoading) return;
    setVersionsLoading(true);
    try {
      const result = await api<{ artifacts: ArtifactRecord[]; nextCursor: string | null }>(`/api/tasks/${encodeURIComponent(taskId)}/artifacts?artifactId=${encodeURIComponent(artifactId)}&latestOnly=false&includeRetired=true&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setVersions(current => cursor ? [...current, ...result.artifacts] : result.artifacts);
      setVersionsCursor(result.nextCursor);
    } catch (reason) { setError(String(reason)); }
    finally { setVersionsLoading(false); }
  }
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    const query = version === undefined ? '' : `?version=${version}`;
    void api<ArtifactRecord>(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}${query}`)
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
  }, [taskId, artifactId, version]);

  const record = content?.artifact ?? null;
  return (
    <div className="artifact-tab" data-testid="artifact-tab">
      {error && <ErrorBox message={`读取产物失败：${error}`} />}
      {!error && !content && <Spinner label="读取产物…" />}
      {content && <details className="artifact-version-history" open={versionsOpen} onToggle={event => {
        setVersionsOpen(event.currentTarget.open);
        if (event.currentTarget.open && !versions.length) void loadVersions();
      }}>
        <summary><Icon name="file" size={15} />当前版本 v{content.artifact.version}<span>历史版本</span></summary>
        <div className="artifact-version-list">
          {versions.map(item => <a key={item.version} data-testid={`artifact-history-${item.version}`} data-active={item.version === content.artifact.version}
            href={`#/tasks/${taskId}/artifacts/${artifactId}?v=${item.version}`}>
            <strong>v{item.version}</strong><span>{new Date(item.createdAt).toLocaleString()}</span><small>{item.state} · {bytesLabel(item.size)}</small>
          </a>)}
          {versionsLoading && <Spinner label="读取历史版本…" />}
          {versionsCursor && <button type="button" className="btn btn-sm" onClick={() => void loadVersions(versionsCursor)}>更早版本</button>}
        </div>
      </details>}
      {content && (
        <>
          <ArtifactPreview content={content} />
        </>
      )}
    </div>
  );
}

export type ArtifactContent = {
  artifact: ArtifactRecord;
  text: string | null;
  truncated: boolean;
  bytes: number;
  events: { type: string; data: Record<string, unknown>; timestamp: number }[];
};

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 102 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function dateLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

export function ArtifactPreview({ content }: { content: ArtifactContent | null }) {
  if (!content) {
    return (
      <div className="artifact-workspace-empty">
        <Icon name="box" size={22} />
        <strong>选择一个产物</strong>
        <span>查看版本、来源、摘要和内容。</span>
      </div>
    );
  }
  const artifact = content.artifact;
  return (
    <article className="artifact-detail">
      <header className="artifact-detail-head">
        <div>
          <div className="artifact-kicker">{artifact.namespace} / {artifact.name} · v{artifact.version}</div>
          <h2>{artifact.title ?? artifact.name}</h2>
        </div>
      </header>
      {artifact.summary && <p className="artifact-summary">{artifact.summary}</p>}
      <dl className="artifact-metadata">
        <div><dt>URI</dt><dd className="mono">{artifact.uri}</dd></div>
        <div><dt>Digest</dt><dd className="mono">{artifact.digest}</dd></div>
        <div><dt>Producer</dt><dd className="mono">{artifact.producer?.nodeId ?? 'host'}</dd></div>
        <div><dt>Created</dt><dd>{dateLabel(artifact.createdAt)}</dd></div>
        <div><dt>Size</dt><dd>{bytesLabel(artifact.size)}</dd></div>
        <div><dt>Media</dt><dd className="mono">{artifact.mediaType}</dd></div>
      </dl>
      {artifact.tags.length > 0 && (
        <div className="artifact-tags">
          {artifact.tags.map(tag => <span key={tag}>#{tag}</span>)}
        </div>
      )}
      <section className="artifact-content">
        <div className="artifact-content-head">
          <strong>内容预览</strong>
          {content.truncated && <span className="faint">只显示前 256 KiB</span>}
        </div>
        {content.text === null ? (
          <div className="artifact-binary">
            <Icon name="file" size={18} />
            <span>二进制内容不注入上下文，此处不展开预览。</span>
          </div>
        ) : artifact.mediaType.includes('markdown') ? (
          <div className="artifact-markdown"><Markdown text={content.text} /></div>
        ) : (
          <pre className="artifact-text-preview">{content.text}</pre>
        )}
      </section>
      {content.events.length > 0 && (
        <section className="artifact-audit">
          <div className="artifact-content-head"><strong>版本事件</strong></div>
          <ol>
            {content.events.slice(0, 8).map(event => (
              <li key={`${event.type}:${event.timestamp}`}>
                <code>{event.type}</code>
                <span>{dateLabel(event.timestamp)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
