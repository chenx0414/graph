import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationMessage } from '../core/conversation-projection.ts';
import { api } from './api.ts';
import { NODE_LABEL } from './labels.ts';
import { ErrorBox, useTaskStream, type StreamEvent } from './shared.tsx';
import type { Entry, NodeRun } from './NodeDetail.tsx';
import { TranscriptRowView } from './TranscriptRows.tsx';
import { Button, Empty, Icon, Pill, Spinner } from './ui.tsx';
import { buildTranscriptRows } from './transcript-model.ts';
import { useTranscriptFollow } from './use-transcript-follow.ts';

function mergeEntries(current: Entry[], incoming: Entry[]) {
  const merged = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of incoming) merged.set(entry.id, entry);
  return [...merged.values()].sort((left, right) => left.seq - right.seq);
}

function nodeMessage(entry: Entry): ConversationMessage {
  return {
    id: entry.id,
    seq: entry.seq,
    role: entry.role,
    kind: entry.kind,
    text: entry.text,
    data: entry.data,
    state: entry.role === 'tool' && entry.kind === 'call' ? 'pending' : 'done',
    operationId: entry.role === 'assistant'
      ? `${entry.operationId ?? 'operation'}:${entry.id}`
      : entry.operationId,
    turn: 0,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
}

function eventNodeId(event: StreamEvent) {
  if (!event.data || typeof event.data !== 'object') return null;
  const nodeId = (event.data as { nodeId?: unknown }).nodeId;
  return typeof nodeId === 'string' ? nodeId : null;
}

/** Read-only Pi transcript for one graph node, using the same rows as the main chat. */
export function AgentNodeChat({ taskId, nodeId, agentName, onClose }: {
  taskId: string | null;
  nodeId: string;
  agentName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<NodeRun | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [error, setError] = useState('');
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const entriesRef = useRef<Entry[]>([]);
  const generationRef = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scope = `${taskId ?? 'none'}:${nodeId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const pump = useCallback(async (startAfter: number | undefined, generation: number) => {
    if (!taskId) return;
    let after = startAfter;
    for (let page = 0; page < 60; page += 1) {
      const query = after === undefined ? 'limit=200' : `after=${after}&limit=200`;
      const result = await api<NodeRun>(`/api/tasks/${taskId}/nodes/${nodeId}/run?${query}`);
      if (scopeRef.current !== scope || generation !== generationRef.current) return;
      setData(result);
      setEntries(current => mergeEntries(current, result.entries));
      const last = result.entries[result.entries.length - 1]?.seq;
      if (last !== undefined) after = last;
      if (!result.hasNewer) return;
    }
  }, [nodeId, scope, taskId]);

  const refresh = useCallback(() => {
    const generation = generationRef.current;
    const after = entriesRef.current[entriesRef.current.length - 1]?.seq;
    void pump(after, generation).catch(reason => {
      if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [pump, scope]);

  useEffect(() => {
    generationRef.current += 1;
    entriesRef.current = [];
    setData(null);
    setEntries([]);
    setError('');
    setOlderExhausted(false);
    if (!taskId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void pump(undefined, generationRef.current)
      .catch(reason => {
        if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (scopeRef.current === scope) setLoading(false);
      });
  }, [pump, scope, taskId, nodeId]);

  const connected = useTaskStream(taskId, event => {
    if (!event.type.startsWith('node.') && !event.type.startsWith('operation.')) return;
    const eventNode = eventNodeId(event);
    if (eventNode && eventNode !== nodeId) return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 120);
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const busy = data?.node.status === 'preparing' || data?.node.status === 'running';
  const transcriptFollow = useTranscriptFollow(scope, Boolean(busy));
  const rows = buildTranscriptRows({
    messages: entries.map(nodeMessage),
    liveTools: [],
    streaming: [],
    busy: Boolean(busy),
  });
  const hasOlder = Boolean(data && data.entryCount > entries.length && !olderExhausted && (entries[0]?.seq ?? 0) > 1);

  async function loadOlder() {
    const first = entries[0]?.seq;
    if (!taskId || first === undefined || olderLoading) return;
    setOlderLoading(true);
    try {
      const generation = generationRef.current;
      const page = await api<{ entries: Entry[] }>(`/api/tasks/${taskId}/nodes/${nodeId}/run?before=${first}&limit=100`);
      if (generation !== generationRef.current) return;
      if (!page.entries.length) setOlderExhausted(true);
      else setEntries(current => mergeEntries(current, page.entries));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOlderLoading(false);
    }
  }

  const status = data?.node.status ?? 'draft';
  return (
    <div
      className="agent-chat-layer"
      data-testid="agent-chat-layer"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="agent-chat-window" data-testid="graph-agent-chat" aria-label={`${agentName} 节点对话`}>
        <header className="agent-chat-header">
          <div className="agent-chat-heading">
            <div className="drawer-eyebrow">Agent 节点对话</div>
            <h3>{agentName} <span className="mono muted">{nodeId}</span></h3>
            <div className="agent-chat-meta">
              <Pill tone={status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'accent' : 'neutral'}>
                {NODE_LABEL[status] ?? status}
              </Pill>
              {data?.instance?.model && <span className="mono">{data.instance.model}</span>}
              {taskId && <span>{connected ? '实时' : '重连中…'}</span>}
              <span>只读</span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭节点对话" aria-label="关闭节点对话">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div
          className="conversation-thread agent-chat-thread"
          ref={transcriptFollow.threadRef}
          onScroll={transcriptFollow.onScroll}
          onWheel={transcriptFollow.onWheel}
          onTouchStart={transcriptFollow.onTouchStart}
        >
          <div className="conversation-thread-inner" ref={transcriptFollow.contentRef}>
            {hasOlder && (
              <Button size="sm" disabled={olderLoading} onClick={() => void loadOlder()}>
                {olderLoading ? '载入中…' : '载入更早记录'}
              </Button>
            )}
            {!taskId && (
              <Empty
                title="尚未派发"
                hint="确认包含这个 Agent 节点的草稿并开始执行后，才能查看它的对话与工具记录。"
              />
            )}
            {taskId && loading && !data && <Spinner label="正在加载节点对话…" />}
            {taskId && error && !data && <ErrorBox message={error} onRetry={refresh} />}
            {taskId && data && !rows.length && (
              <Empty title="暂无对话记录" hint="节点还没有产生任务说明、工具调用或回复。" />
            )}
            {taskId && rows.map(row => (
              <TranscriptRowView
                key={row.id}
                row={row}
                assistantAuthor={`${agentName} · 回复`}
                userAuthor="任务说明"
              />
            ))}
          </div>
        </div>

        <footer className="agent-chat-footer">
          <Icon name="message" size={13} />
          这里展示节点真实执行记录，不会向 Agent 插话，也不会触发工具。
          {error && data && <span className="danger-text">{error}</span>}
        </footer>
      </section>
    </div>
  );
}
