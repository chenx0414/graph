/**
 * The node chat tab: one graph node's subagent, opened as its own window.
 *
 * Two things live here and nothing else: what the node was actually told (its
 * injected system prompt and the briefing its session carries, both read back
 * from the ledger and the session file rather than recomputed), and its own
 * transcript. Usage, capability lists, context provenance and the
 * operation ledger used to sit next to them; they are deliberately gone - the
 * graph and the task records are where that belongs.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { AgentNodeChat } from './AgentNodeChat.tsx';
import { NODE_LABEL } from './labels.ts';
import { RecordedPromptPanel } from './PromptPanel.tsx';
import { Button, Icon, Pill, Spinner, Stat, toast } from './ui.tsx';

interface NodePromptView {
  nodeId: string;
  kind: string;
  action: string;
  role: string | null;
  definitionVersion: string | null;
  model: string | null;
  status: string;
  recorded: { operationId: string; at: number; text: string; tools: string | null } | null;
  briefing: { text: string; sessionFile: string } | null;
  notes: string[];
}

/** What the overview reads: enough to say who this node is and how it is doing. */
interface NodeOverview {
  node: { kind: string; action: string; status: string; definitionVersion?: string };
  instance: { model: string | null; used: number; budget: number | null; unlimited: boolean } | null;
  timing?: { totalMs: number | null; runMs: number | null; inProgress?: boolean } | null;
  entryCount: number;
}

/** One transcript entry, as the node's session records it. */
export type { Entry } from './node-transcript.ts';
import type { Entry } from './node-transcript.ts';

/** The node-run payload the transcript reader consumes. */
export interface NodeRun {
  taskId: string; nodeId: string;
  node: { id: string; kind: string; action: string; role: string | null; status: string; definitionVersion?: string; input?: unknown };
  instance: { id: string; model: string | null; definitionVersion: string | null; used: number; budget: number | null; unlimited: boolean; modelsUsed: string[] } | null;
  session: { sessionId: string; sessionFile: string | null } | null;
  operations: unknown[]; invocations: unknown[]; questions: unknown[]; evidence: unknown[];
  entries: Entry[]; entryCount: number; hasOlder: boolean; hasNewer: boolean; phase: string;
}

function roleLabel(role: string | null): string {
  if (role === 'main') return 'main Agent';
  if (role === 'reviewer') return 'reviewer';
  if (role === 'worker') return 'worker';
  return '程序节点';
}

export function NodeChatTab({ taskId, nodeId, agentName }: {
  taskId: string;
  nodeId: string;
  agentName?: string | null;
}) {
  // The recorded prompt is read when the tab opens: an agent node that never sent has
  // nothing to show, and the tab must not pretend otherwise.
  const [prompt, setPrompt] = useState<NodePromptView | null>(null);
  // The window is named after the agent that runs the node, and only the graph knows that name.
  const [named, setNamed] = useState<string | null>(agentName ?? null);
  const [overview, setOverview] = useState<NodeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api<NodeOverview>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/run`)
      .then(view => { if (!cancelled) setOverview(view); })
      .catch(() => { if (!cancelled) setOverview(null); });
    if (!agentName) {
      void api<{ nodes: { id: string; agent?: { name?: string } }[] }>(`/api/tasks/${taskId}/graph`)
        .then(payload => {
          const name = payload.nodes.find(node => node.id === nodeId)?.agent?.name;
          if (!cancelled && name) setNamed(name);
        })
        .catch(() => {});
    }
    void api<NodePromptView>(`/api/tasks/${taskId}/nodes/${encodeURIComponent(nodeId)}/prompt`)
      .then(view => { if (!cancelled) setPrompt(view); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, nodeId]);

  async function copyBriefing() {
    if (!prompt?.briefing) return;
    try {
      await navigator.clipboard.writeText(prompt.briefing.text);
      toast('简报已复制', 'success');
    } catch (reason) {
      toast(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    }
  }

  const duration = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
    ? '未记录'
    : value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;

  const promptControl = (
      <details className="node-prompt-card node-prompt-popover" data-testid="node-prompt">
        <summary className="icon-button node-prompt-summary" title="System prompt" aria-label="System prompt"><Icon name="spark" size={16} /></summary>
        <div className="node-prompt-popover-panel">
        <div className="node-prompt-popover-heading"><strong>System prompt</strong><span>该节点实际注入的上下文与简报</span></div>
        {loading && !prompt ? <Spinner label="正在读取…" />
          : error ? <div className="form-error" data-testid="node-prompt-error">{error}</div>
            : prompt ? (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span data-testid="node-prompt-role">
                    <Pill tone="accent">{roleLabel(prompt.role)}</Pill>
                  </span>
                  {prompt.definitionVersion && <span className="muted">{prompt.definitionVersion}</span>}
                  {prompt.model && <span className="muted">{prompt.model}</span>}
                </div>
                {prompt.notes.length > 0 && (
                  <ul className="list" data-testid="node-prompt-notes">
                    {prompt.notes.map(note => <li key={note} className="muted">{note}</li>)}
                  </ul>
                )}
                <RecordedPromptPanel
                  testId="node-prompt-sent"
                  text={prompt.recorded?.text ?? null}
                  tools={prompt.recorded?.tools ?? null}
                  emptyText="台账里没有这个节点的发送记录。"
                />
                {prompt.briefing && (
                  <div className="agent-preview-panel" data-testid="node-briefing">
                    <div className="agent-preview-meta">
                      <strong>简报（该节点会话的第一条 user 消息）</strong>
                      <span>{`${prompt.briefing.text.length.toLocaleString()} 字符`}</span>
                      <Button size="sm" icon="file" onClick={() => void copyBriefing()}>复制简报</Button>
                    </div>

                    <pre className="agent-preview-markdown" data-testid="node-briefing-text">{prompt.briefing.text}</pre>
                  </div>
                )}
              </div>
            ) : null}
        </div>
      </details>
  );
  return (
    <div className="conversation-page window-fill" data-testid="node-chat-tab">
      {/* The tab bar owns the title; the prompt lives in its top-right control. */}
      {document.getElementById('conversation-toolbar') && createPortal(promptControl, document.getElementById('conversation-toolbar')!)}
      <div className="conversation-body" data-view="node">
        <div className="conversation-main">
      {overview && (
        <section className="conversation-alert node-overview" data-testid="node-overview">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Pill tone="accent">{`${overview.node.kind} · ${overview.node.action}`}</Pill>
            <Pill tone={overview.node.status === 'succeeded' ? 'success' : overview.node.status === 'failed' ? 'danger' : overview.node.status === 'running' ? 'accent' : 'neutral'}>
              {NODE_LABEL[overview.node.status] ?? overview.node.status}
            </Pill>
            {overview.node.definitionVersion && <span className="muted">{overview.node.definitionVersion}</span>}
            {overview.instance?.model && <span className="muted mono">{overview.instance.model}</span>}
          </div>
          <div className="stat-grid" style={{ marginTop: 10 }}>
            <Stat label="运行" value={duration(overview.timing?.runMs ?? null)} hint="实际工作时段之和" />
            <Stat label="总历时" value={duration(overview.timing?.totalMs ?? null)} hint="首次派发到最后结算" />
            <Stat
              label="用量"
              value={overview.instance ? overview.instance.used.toLocaleString('en-US') : '未记录'}
              hint={overview.instance?.unlimited ? '额度不限' : overview.instance?.budget === null || overview.instance?.budget === undefined ? '预算尚无记录' : `预算 ${overview.instance.budget.toLocaleString('en-US')}`}
            />
            <Stat label="记录" value={overview.entryCount} hint="该节点会话条目数" />
          </div>
        </section>
      )}


      <AgentNodeChat taskId={taskId} nodeId={nodeId} agentName={named ?? nodeId} onRunUpdate={setOverview} page />
        </div>
      </div>
    </div>
  );
}
