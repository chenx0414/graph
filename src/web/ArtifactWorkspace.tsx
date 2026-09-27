import { useCallback, useEffect, useState } from 'react';
import type { ArtifactRecord } from '../core/artifact-workspace.ts';
import { api } from './api.ts';
import { Markdown } from './Markdown.tsx';
import { Empty, Icon, Pill, Spinner, toast } from './ui.tsx';

type ArtifactPage = { artifacts: ArtifactRecord[]; total: number; nextCursor: string | null };
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
        <div className="artifact-detail-actions">
          <a
            className="btn btn-sm"
            href={`/api/tasks/${encodeURIComponent(artifact.taskId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/${artifact.version}/content?download=true`}
            download
          >
            <Icon name="box" size={13} />
            下载
          </a>
        </div>
      </header>
      <div className="artifact-detail-badges">
        <Pill tone={artifact.scope === 'project' ? 'info' : 'neutral'}>{artifact.scope === 'project' ? '项目共享' : '任务共享'}</Pill>
        <Pill tone={artifact.state === 'published' ? 'success' : 'warn'}>{artifact.state === 'published' ? '已发布' : '已撤回'}</Pill>
        <Pill tone={artifact.trust === 'accepted' ? 'success' : artifact.trust === 'reviewed' ? 'info' : 'warn'}>{artifact.trust}</Pill>
        {artifact.schemaKind && <Pill tone="neutral">{artifact.schemaKind}@{artifact.schemaVersion}</Pill>}
      </div>
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
            <span>二进制内容不直接注入上下文，请使用下载按钮查看。</span>
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

export function ArtifactWorkspace({ conversationId, projectBound }: { conversationId: string; projectBound: boolean }) {
  const [data, setData] = useState<ArtifactPage | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [namespace, setNamespace] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [selected, setSelected] = useState<ArtifactRecord | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('prefix', query.trim());
    if (namespace) params.set('namespace', namespace);
    if (includeRetired) params.set('includeRetired', 'true');
    try {
      const page = await api<ArtifactPage>(`/api/conversations/${encodeURIComponent(conversationId)}/artifacts?${params}`);
      setData(page);
      setError('');
      setSelected(current => {
        const next = current
          ? page.artifacts.find(item => item.artifactId === current.artifactId && item.version === current.version)
          : undefined;
        return next ?? page.artifacts[0] ?? null;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [conversationId, includeRetired, namespace, query]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setLoadingContent(true);
    void api<ArtifactContent>(
      `/api/tasks/${encodeURIComponent(selected.taskId)}/artifacts/${encodeURIComponent(selected.artifactId)}/${selected.version}/content`,
    ).then(result => {
      if (!cancelled) setContent(result);
    }).catch(reason => {
      if (!cancelled) toast(`读取产物失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    }).finally(() => {
      if (!cancelled) setLoadingContent(false);
    });
    return () => { cancelled = true; };
  }, [selected]);

  async function promote() {
    if (!selected || promoting || selected.scope === 'project') return;
    setPromoting(true);
    try {
      const promoted = await api<ArtifactRecord>(
        `/api/tasks/${encodeURIComponent(selected.taskId)}/artifacts/${encodeURIComponent(selected.artifactId)}/${selected.version}/promote`,
        {
          method: 'POST',
          body: JSON.stringify({ requestId: `promote-${crypto.randomUUID()}` }),
        },
      );
      toast('已提升到项目共享知识', 'success');
      await load();
      setSelected(promoted);
    } catch (reason) {
      toast(`提升失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    } finally {
      setPromoting(false);
    }
  }

  const artifacts = data?.artifacts ?? [];
  const namespaces = [...new Set(artifacts.map(item => item.namespace))].sort();

  return (
    <div className="artifact-workspace" data-testid="artifact-workspace">
      <aside className="artifact-sidebar">
        <div className="artifact-sidebar-head">
          <div>
            <div className="artifact-kicker">Shared workspace</div>
            <h2>共享产物</h2>
          </div>
          <Pill tone="neutral">{data?.total ?? 0}</Pill>
        </div>
        <div className="artifact-filters">
          <label className="artifact-search">
            <Icon name="search" size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称…" aria-label="搜索共享产物" />
          </label>
          <select value={namespace} onChange={event => setNamespace(event.target.value)} aria-label="筛选产物命名空间">
            <option value="">全部空间</option>
            {namespaces.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <label className="artifact-retired-toggle">
            <input type="checkbox" checked={includeRetired} onChange={event => setIncludeRetired(event.target.checked)} />
            显示已撤回
          </label>
        </div>
        <div className="artifact-list" data-testid="artifact-list">
          {data === null && <Spinner label="加载共享产物…" />}
          {error && <div className="artifact-error">{error}</div>}
          {data !== null && artifacts.length === 0 && (
            <Empty icon="box" title="还没有共享产物" hint="Agent 发布 Plan、文献集、审查报告或交付文件后，会显示在这里。" />
          )}
          {artifacts.map(artifact => (
            <button
              type="button"
              className="artifact-list-item"
              data-active={selected?.artifactId === artifact.artifactId && selected.version === artifact.version}
              data-testid={`artifact-list-item-${artifact.artifactId}-${artifact.version}`}
              key={`${artifact.artifactId}:${artifact.version}`}
              onClick={() => setSelected(artifact)}
            >
              <span className="artifact-list-icon"><Icon name={artifact.scope === 'project' ? 'box' : 'file'} size={14} /></span>
              <span className="artifact-list-copy">
                <strong>{artifact.title ?? artifact.name}</strong>
                <span>{artifact.namespace}/{artifact.name} · v{artifact.version}</span>
                <span>{artifact.summary ?? artifact.producer?.nodeId ?? 'host'} · {bytesLabel(artifact.size)}</span>
              </span>
              {artifact.scope === 'project' && <span className="artifact-scope-dot" title="项目共享" />}
            </button>
          ))}
        </div>
      </aside>
      <section className="artifact-main">
        {projectBound && selected?.scope === 'task' && (
          <div className="artifact-promote-bar">
            <span>该版本只对当前任务可见。</span>
            <button type="button" className="btn btn-sm" disabled={promoting} onClick={() => void promote()}>
              <Icon name="box" size={13} />
              {promoting ? '提升中…' : '提升到项目共享'}
            </button>
          </div>
        )}
        {loadingContent ? <Spinner label="读取产物内容…" /> : <ArtifactPreview content={content} />}
      </section>
    </div>
  );
}
