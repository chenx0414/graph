import { QuestionReply } from './Questions.tsx';
import { Button, Icon, Pill } from './ui.tsx';

export type NodeQuestion = {
  id: string;
  kind: string;
  data?: Record<string, unknown>;
};

export function openNodeQuestions(questions: unknown[]): NodeQuestion[] {
  return questions.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.kind !== 'string') return [];
    if (record.status !== undefined && record.status !== 'open') return [];
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : {};
    return [{ id: record.id, kind: record.kind, data }];
  });
}

export function NodeChatQuestions({ taskId, questions, onDone }: {
  taskId: string;
  questions: unknown[];
  onDone: () => void;
}) {
  const open = openNodeQuestions(questions);
  if (!taskId || !open.length) return null;
  return (
    <section className="conversation-question-composer" data-testid="node-chat-questions" aria-label="等待你确认">
      <ul className="list">
        {open.map(question => (
          <QuestionReply key={question.id} taskId={taskId} question={{ id: question.id, kind: question.kind, data: question.data ?? {} }} onDone={onDone} />
        ))}
      </ul>
    </section>
  );
}

export function NodeChatPending({ taskId, questions, queued, onDone }: {
  taskId: string;
  questions: unknown[];
  queued: { seq: number; text: string }[];
  onDone: () => void;
}) {
  return (
    <>
      {queued.length > 0 && (
        <div className="queued-messages" data-testid="node-chat-queued">
          {queued.map((item, index) => (
            <div className="queued-message" data-testid="node-chat-queued-item" key={item.seq}>
              <div className="queued-message-body"><p>{item.text}</p></div>
              <span className="queued-message-order">{index + 1}</span>
            </div>
          ))}
        </div>
      )}
      <NodeChatQuestions taskId={taskId} questions={questions} onDone={onDone} />
    </>
  );
}

export function NodeChatPaused() {
  return (
    <section className="conversation-alert" data-testid="node-chat-paused">
      <div className="conversation-pause-note">
        <Icon name="pause" size={15} />
        <span><strong>这个节点所在的任务已暂停。</strong> 正在跑的回合会在当前工具调用收尾后停下，不再发起新的模型请求；继续后会接着跑被停下的那个回合。</span>
      </div>
    </section>
  );
}

export function NodeComposerFooter({ stopPhase, busy, agentNode, sending, canSteer, onSteer, onStop, throughput }: {
  stopPhase: 'idle' | 'stopping' | 'stopped';
  busy: boolean;
  agentNode: boolean;
  sending: boolean;
  canSteer: boolean;
  onSteer: () => void;
  onStop: () => void;
  throughput?: { outputTokens?: number | null; latencyMs?: number | null; tokensPerSecond?: number | null } | undefined;
}) {
  return (
    <div className="composer-footer">
      {stopPhase !== 'idle' && (
        <span className="composer-note" data-testid="node-stop-status" data-phase={stopPhase === 'stopped' ? 'stopped' : 'stopping'}>
          {stopPhase === 'stopped' ? '已停止。' : '停止中…'}
        </span>
      )}
      {/* The node's own speed, from its newest settled provider call. */}
      <span
        className="muted"
        title={throughput?.outputTokens && throughput?.latencyMs
          ? `最近一次完成的请求写了 ${throughput.outputTokens} tokens，用时 ${(throughput.latencyMs / 1000).toFixed(1)} 秒`
          : '这个节点还没有完成的请求'}
        data-testid="node-telemetry-tps"
        data-tps={throughput?.tokensPerSecond ?? undefined}
      >TPS {typeof throughput?.tokensPerSecond === 'number' ? (throughput.tokensPerSecond >= 10 ? throughput.tokensPerSecond.toFixed(0) : throughput.tokensPerSecond.toFixed(1)) : '—'}</span>
      {busy && agentNode && <span className="row">
        <Button size="sm" disabled={sending || !canSteer} onClick={onSteer}>立即引导</Button>
        <Button size="sm" disabled={sending} onClick={onStop}>停止节点</Button>
      </span>}
    </div>
  );
}

export function NodeChatHeader({ agentName, nodeId, status, statusLabel, model, connected, taskId, onClose }: {
  agentName: string;
  nodeId: string;
  status: string;
  statusLabel: string | null;
  model: string | null;
  connected: boolean;
  taskId: string | null | undefined;
  onClose?: (() => void) | undefined;
}) {
  return (
    <header className="agent-chat-header">
      <div className="agent-chat-heading">
        <div className="drawer-eyebrow">Agent 节点对话</div>
        <h3>{agentName} <span className="mono muted">{nodeId}</span></h3>
        <div className="agent-chat-meta">
          <Pill tone={status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'accent' : 'neutral'}>
            {statusLabel ?? status}
          </Pill>
          {model && <span className="mono">{model}</span>}
          {taskId && <span>{connected ? '实时' : '重连中…'}</span>}
          <span>节点对话</span>
        </div>
      </div>
      {onClose && (
        <button type="button" className="icon-button" onClick={onClose} title="关闭节点对话" aria-label="关闭节点对话">
          <Icon name="close" size={16} />
        </button>
      )}
    </header>
  );
}
