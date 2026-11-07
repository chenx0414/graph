import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { nodeMessages } from './node-transcript.ts';
import { ChatComposer, type ChatAttachment } from './ChatComposer.tsx';
import { api } from './api.ts';
import { NODE_LABEL } from './labels.ts';
import { ErrorBox, useTaskStream, type StreamEvent } from './shared.tsx';
import type { Entry, NodeRun } from './NodeDetail.tsx';
import { NodeChatHeader, NodeChatPaused, NodeChatPending, NodeComposerFooter } from './NodeChatAlerts.tsx';
import { TranscriptRowView } from './TranscriptRows.tsx';
import { captureHistoryAnchor, restoreHistoryAnchor, wantsOlderHistory } from './older-history.ts';
import { Button, Empty, Icon, Pill, Spinner } from './ui.tsx';
import { buildTranscriptRows } from './transcript-model.ts';
import { useTranscriptFollow } from './use-transcript-follow.ts';

const AUTO_HISTORY_PAGES = 40;

function mergeEntries(current: Entry[], incoming: Entry[]) {
  const merged = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of incoming) {
    const previous = merged.get(entry.id);
    if (previous?.contentTruncated === false && entry.contentTruncated === true) continue;
    merged.set(entry.id, entry);
  }
  return [...merged.values()].sort((left, right) => left.seq - right.seq);
}

function eventNodeId(event: StreamEvent) {
  if (!event.data || typeof event.data !== 'object') return null;
  const nodeId = (event.data as { nodeId?: unknown }).nodeId;
  return typeof nodeId === 'string' ? nodeId : null;
}

export function AgentNodeChat({ taskId, nodeId, agentName, onClose, onRunUpdate, page = false }: {
  taskId: string | null;
  nodeId: string;
  agentName: string;
  onClose?: () => void;
  onRunUpdate?: (run: NodeRun) => void;
  page?: boolean;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const pendingSend = useRef<{ text: string; requestId: string } | null>(null);
  const pendingControl = useRef<{ action: 'steer_node' | 'stop_node'; text: string; requestId: string } | null>(null);
  const [data, setData] = useState<NodeRun | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [error, setError] = useState('');
  const [olderLoading, setOlderLoading] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState<string | null>(null);
  const [unreadEntries, setUnreadEntries] = useState<ReadonlySet<string>>(() => new Set());
  const [stopPhase, setStopPhase] = useState<'idle' | 'stopping' | 'stopped'>('idle');
  const autoReadAttempted = useRef<Set<string>>(new Set());
  const [olderExhausted, setOlderExhausted] = useState(false);
  const olderPending = useRef(false);
  const historyAnchor = useRef<ReturnType<typeof captureHistoryAnchor>>(null);
  const loadedScope = useRef<string | null>(null);
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
      const result = await api<NodeRun>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/run?${query}`);
      if (scopeRef.current !== scope || generation !== generationRef.current) return;
      setData(result);
      onRunUpdate?.(result);
      setEntries(current => mergeEntries(current, result.entries));
      const last = result.entries[result.entries.length - 1]?.seq;
      if (last !== undefined) after = last;
      if (!result.hasNewer) return;
    }
  }, [nodeId, scope, taskId, onRunUpdate]);

  const refresh = useCallback(() => {
    const generation = generationRef.current;
    const after = entriesRef.current[entriesRef.current.length - 1]?.seq;
    void pump(after, generation).catch(reason => {
      if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [pump, scope]);

  useEffect(() => {
    generationRef.current += 1;
    autoReadAttempted.current = new Set();
    setUnreadEntries(new Set());
    if (loadedScope.current !== scope) {
      loadedScope.current = scope;
      entriesRef.current = [];
      setData(null); setEntries([]); setText(''); setOlderExhausted(false);
    }
    setError('');
    if (!taskId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void pump(entriesRef.current.at(-1)?.seq, generationRef.current)
      .catch(reason => {
        if (scopeRef.current === scope) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (scopeRef.current === scope) setLoading(false);
      });
    return () => { generationRef.current += 1; };
  }, [pump, scope, taskId, nodeId]);

  const connected = useTaskStream(taskId, event => {
    if (!event.type.startsWith('node.') && !event.type.startsWith('operation.') && !event.type.startsWith('graph.')) return;
    const eventNode = eventNodeId(event);
    if (eventNode && eventNode !== nodeId) return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 120);
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  useEffect(() => {
    if (!taskId) return;
    const scopeAtStart = scope;
    const readOne = async (entry: Entry) => {
      autoReadAttempted.current.add(entry.id);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await api<{ entries: Entry[] }>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/run?entryId=${encodeURIComponent(entry.id)}`);
          if (scopeRef.current !== scopeAtStart) return;
          setEntries(current => mergeEntries(current, result.entries));
          setUnreadEntries(current => {
            if (!current.has(entry.id)) return current;
            const next = new Set(current);
            next.delete(entry.id);
            return next;
          });
          return;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
          if (scopeRef.current !== scopeAtStart) return;
        }
      }
      if (scopeRef.current === scopeAtStart) setUnreadEntries(current => new Set(current).add(entry.id));
    };
    for (const entry of entries) {
      if (entry.contentTruncated && !autoReadAttempted.current.has(entry.id)) void readOne(entry);
    }
  }, [entries, nodeId, scope, taskId]);

  const busy = data?.node.status === 'preparing' || data?.node.status === 'running';
  useEffect(() => {
    if (stopPhase === 'stopping' && !busy) setStopPhase('stopped');
    if (stopPhase === 'stopped' && busy) setStopPhase('idle');
  }, [busy, stopPhase]);
  const transcriptFollow = useTranscriptFollow(scope, Boolean(busy));
  const rows = useMemo(() => buildTranscriptRows({
    messages: nodeMessages(entries, (data?.operations ?? []) as { id: string; state: string; workerActive?: boolean }[], Boolean(busy)),
    liveTools: [],
    streaming: [],
    busy: Boolean(busy),
  }), [entries, data?.operations, busy]);
  const expandedAnswers = new Set<string>();
  const lastAnswers = new Map<string, Entry>();
  for (const entry of entries) if (entry.role === 'assistant' && entry.operationId) lastAnswers.set(entry.operationId, entry);
  for (const [operationId, entry] of lastAnswers) {
    if (entry.contentTruncated === false && (entry.contentBytes ?? 0) > 4096) expandedAnswers.add(operationId);
  }
  const hasOlder = Boolean(data && data.entryCount > entries.length && !olderExhausted && (entries[0]?.seq ?? 0) > 1);

  const autoHistoryPages = useRef(0);
  useEffect(() => {
    if (!hasOlder || olderLoading || error) return;
    if (autoHistoryPages.current >= AUTO_HISTORY_PAGES) return;
    autoHistoryPages.current += 1;
    void loadOlder();
  }, [hasOlder, olderLoading, entries, error]);

  useLayoutEffect(() => {
    const thread = transcriptFollow.threadRef.current;
    historyAnchor.current = restoreHistoryAnchor(thread, historyAnchor.current);
  }, [entries]);
  async function send() {
    if (!taskId || sending || !text.trim()) return;
    const message = text.trim() + attachments.map(item => `\n\n附件 ${item.name}:\n${item.text}`).join('');
    const request = pendingSend.current?.text === message ? pendingSend.current : { text: message, requestId: crypto.randomUUID() };
    pendingSend.current = request;
    setSending(true); setError('');
    try {
      await api(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/messages`, { method: 'POST', body: JSON.stringify(request) });
      setText(''); setAttachments([]); pendingSend.current = null;
      refresh(); transcriptFollow.scrollToLatest('auto');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSending(false); }
  }
  async function controlNode(action: 'steer_node' | 'stop_node') {
    if (!taskId || sending || !busy || (action === 'steer_node' && !text.trim())) return;
    const message = action === 'steer_node' ? text.trim() : '';
    const previous = pendingControl.current;
    const command = previous?.action === action && previous.text === message ? previous : { action, text: message, requestId: crypto.randomUUID() };
    pendingControl.current = command;
    setSending(true); setError('');
    if (action === 'stop_node') setStopPhase('stopping');
    try {
      await api(`/api/tasks/${taskId}/graph/control`, { method: 'POST', body: JSON.stringify({ ...command, nodeId }) });
      if (action === 'steer_node') setText('');
      pendingControl.current = null;
      refresh(); transcriptFollow.scrollToLatest('auto');
    } catch (reason) {
      if (action === 'stop_node') setStopPhase('idle');
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    finally { setSending(false); }
  }
  const composer = <div className="conversation-composer-wrap node-chat-composer">
    {error && <ErrorBox message={error} />}
    <ChatComposer value={text} onChange={setText} attachments={attachments} onAttachmentsChange={setAttachments}
      allowAttachments={false} projectId={null} placeholder={busy ? `向 ${agentName} 发送补充说明…` : `向 ${agentName} 发送返工要求…`}
      onSend={() => void send()} sendDisabled={sending || !taskId || data?.node.kind !== 'agent' || !text.trim()}
      inputTestId="node-chat-input" sendTestId="node-chat-send" history={entries.filter(entry => entry.role === 'user' && entry.kind === 'chat').map(entry => entry.text)} />
    <NodeComposerFooter stopPhase={stopPhase} busy={busy} agentNode={data?.node.kind === 'agent'} sending={sending}
      canSteer={Boolean(text.trim())} onSteer={() => void controlNode('steer_node')} onStop={() => void controlNode('stop_node')}
      throughput={data?.throughput} />
  </div>;
  const onScroll = () => {
    transcriptFollow.onScroll();
    const thread = transcriptFollow.threadRef.current;
    if (wantsOlderHistory(thread, { pinned: transcriptFollow.isPinned(), hasOlder })) void loadOlder();
  };
  async function loadOlder() {
    const first = entries[0]?.seq;
    if (!taskId || first === undefined || olderPending.current) return;
    olderPending.current = true;
    setOlderLoading(true);
    try {
      const generation = generationRef.current;
      const page = await api<{ entries: Entry[] }>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/run?before=${first}&limit=100`);
      if (generation !== generationRef.current) return;
      if (!page.entries.length) setOlderExhausted(true);
      else {
        historyAnchor.current = captureHistoryAnchor(transcriptFollow.threadRef.current);
        setEntries(current => mergeEntries(current, page.entries));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      olderPending.current = false;
      setOlderLoading(false);
    }
  }

  async function readEntry(entryId: string) {
    if (!taskId || loadingEntry) return;
    const generation = generationRef.current;
    setLoadingEntry(entryId);
    try {
      const result = await api<{ entries: Entry[] }>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/run?entryId=${encodeURIComponent(entryId)}`);
      if (generation === generationRef.current) setEntries(current => mergeEntries(current, result.entries));
    } catch (reason) {
      if (generation === generationRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setLoadingEntry(null); }
  }

  const status = data?.node.status ?? 'draft';
  const entriesView = (
    <>
      {hasOlder && (
        <Button size="sm" data-testid="node-load-older" disabled={olderLoading} onClick={() => void loadOlder()}>
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
      {entries.filter(entry => entry.contentTruncated && unreadEntries.has(entry.id)).map(entry => (
        <div className="node-long-entry" key={`long-${entry.id}`}>
          <span className="muted">长记录 · {entry.role === 'tool' ? '工具' : entry.role === 'assistant' ? '回复' : '任务说明'} · {entry.contentBytes?.toLocaleString()} 字节</span>
          <Button size="sm" data-testid={`node-read-entry-${entry.id}`} disabled={loadingEntry !== null} onClick={() => void readEntry(entry.id)}>
            {loadingEntry === entry.id ? '读取中…' : '读取完整记录'}
          </Button>
        </div>
      ))}
      {taskId && rows.map(row => (
        <TranscriptRowView
          key={`${row.id}:${row.kind === 'assistant' && expandedAnswers.has(row.operationId) ? 'expanded' : 'initial'}`}
          row={row}
          assistantAuthor={`${agentName} · 回复`}
          userAuthor="任务说明"
        />
      ))}
    </>
  );

  if (page) {
    return (
      <>
      <div className="conversation-thread-shell" data-testid="graph-agent-chat" data-page="true" aria-label={`${agentName} 节点对话`}>
        {data?.phase === 'paused' && <NodeChatPaused />}
        <div
          className="conversation-thread"
          data-testid="node-message-list"
          ref={transcriptFollow.threadRef}
          onScroll={onScroll}
          onWheel={transcriptFollow.onWheel}
          onTouchStart={transcriptFollow.onTouchStart}
        >
          <div className="conversation-thread-inner" ref={transcriptFollow.contentRef}>
            {entriesView}
            <div className="conversation-runway" style={{ height: transcriptFollow.runway }} aria-hidden="true" />
          </div>
        </div>
        {transcriptFollow.showJump && (
          <button type="button" className="jump-to-latest" data-testid="jump-to-latest" onClick={() => transcriptFollow.scrollToLatest('smooth')}>
            <Icon name="chevron" size={13} />
            回到最新
          </button>
        )}
      </div>
      <NodeChatPending taskId={taskId ?? ''} questions={data?.questions ?? []} queued={data?.queued ?? []} onDone={refresh} />
      {composer}
      </>
    );
  }

  const frame = (
      <section
        className="agent-chat-window"
        data-testid="graph-agent-chat"
        data-page={page}
        aria-label={`${agentName} 节点对话`}
      >
        <NodeChatHeader agentName={agentName} nodeId={nodeId} status={status} statusLabel={NODE_LABEL[status] ?? null}
          model={data?.instance?.model ?? null} connected={connected} taskId={taskId} onClose={onClose} />

        {data?.phase === 'paused' && <NodeChatPaused />}
        <div
          className="conversation-thread agent-chat-thread"
          ref={transcriptFollow.threadRef}
          onScroll={onScroll}
          onWheel={transcriptFollow.onWheel}
          onTouchStart={transcriptFollow.onTouchStart}
        >
          <div className="conversation-thread-inner" ref={transcriptFollow.contentRef}>
            {entriesView}
          </div>
        </div>

        <NodeChatPending taskId={taskId ?? ''} questions={data?.questions ?? []} queued={data?.queued ?? []} onDone={refresh} />
        {composer}
      </section>
  );
  return (
    <div
      className="agent-chat-layer"
      data-testid="agent-chat-layer"
      onClick={event => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      {frame}
    </div>
  );
}
