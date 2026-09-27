/**
 * The node chat tab: one graph node's subagent, opened as its own window.
 *
 * Two things live here and nothing else: what the node was actually told (its
 * injected system prompt and the briefing its session carries, both read back
 * from the ledger and the session file rather than recomputed), and its own
 * read-only transcript. Usage, capability lists, context provenance and the
 * operation ledger used to sit next to them; they are deliberately gone - the
 * graph and the task records are where that belongs.
 */
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { AgentNodeChat } from './AgentNodeChat.tsx';
import { RecordedPromptPanel } from './PromptPanel.tsx';
import { Button, Pill, Spinner, toast } from './ui.tsx';

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

/** One transcript entry, as the node's session records it. */
export interface Entry { seq: number; id: string; role: string; kind: string; text: string; data: Record<string, unknown> | null; operationId: string | null; createdAt: number }

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void api<NodePromptView>(`/api/tasks/${taskId}/nodes/${nodeId}/prompt`)
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

  return (
    <div className="node-chat-tab" data-testid="node-chat-tab">
      <section className="card node-prompt-card" data-testid="node-prompt">
        <h4 className="section-title">System prompt（该节点实际注入）</h4>
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
                    <p className="agent-preview-notice">
                      从该节点自己的会话文件原样读出：<code>{prompt.briefing.sessionFile}</code>。它不是重算的简报，而是那次派发真正带上的那条 user 消息。
                    </p>
                    <pre className="agent-preview-markdown" data-testid="node-briefing-text">{prompt.briefing.text}</pre>
                  </div>
                )}
              </div>
            ) : null}
      </section>

      <AgentNodeChat taskId={taskId} nodeId={nodeId} agentName={agentName ?? nodeId} page />
    </div>
  );
}
