/** Unconfirmed versions preview the proposal. Once accepted, this same window
 * shows the runtime GraphPanel and follows its revisions through completion. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { ConversationGraphBoard, type DraftGraph, type ProposalDetail } from './Conversation.tsx';
import { ErrorBox, useAsync, useEventStream } from './shared.tsx';
import { Card, Spinner } from './ui.tsx';
import { GraphPanel } from './GraphPanel.tsx';

type ConversationView = {
  id: string;
  proposal: ProposalDetail | null;
  tasks: { id: string; status: string; used?: number | null; budget?: number | null; openQuestions?: unknown[] }[];
  evidence?: unknown[];
  accepted?: { proposalVersion: number; taskId: string }[];
  master?: { used: number; budget: number | null; unlimited?: boolean } | null;
};

export function DraftGraphTab({ conversationId, version }: { conversationId: string; version?: number }) {
  const { data: view, error, reload } = useAsync(() => api<ConversationView>(`/api/conversations/${conversationId}`), [conversationId]);
  const [graph, setGraph] = useState<DraftGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // The window names its own version, so it reads that version's proposal rather than whichever
  // one the conversation last drafted.
  const [chosen, setChosen] = useState<ProposalDetail | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEventStream(`/api/conversations/${conversationId}/events/stream`, () => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(reload, 150);
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const latest = view?.proposal ?? null;
  const selected = version ?? latest?.version ?? null;
  useEffect(() => {
    if (selected === null) { setChosen(null); return; }
    if (latest && latest.version === selected) { setChosen(latest); return; }
    let cancelled = false;
    void api<ProposalDetail>(`/api/conversations/${conversationId}/proposals/${selected}`)
      .then(payload => { if (!cancelled) setChosen(payload); })
      .catch(() => { if (!cancelled) setChosen(null); });
    return () => { cancelled = true; };
  }, [conversationId, selected, latest]);
  const proposal = chosen;
  // If this draft has already been accepted, the board reads that task's live node states.
  const acceptedTaskId = view?.accepted?.find(item => item.proposalVersion === selected)?.taskId ?? null;
  const load = useCallback(async () => {
    if (acceptedTaskId) { setGraph(null); setGraphLoading(false); return; }
    if (selected === null) { setGraph(null); setGraphLoading(false); return; }
    setGraphLoading(true);
    try {
      const payload = await api<DraftGraph>(`/api/conversations/${conversationId}/draft-graph?version=${selected}`);
      setGraph(payload);
    } catch { setGraph(null); } finally { setGraphLoading(false); }
  }, [conversationId, selected, acceptedTaskId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <Card><Spinner label="正在读取草稿…" /></Card>;
  if (acceptedTaskId) return <GraphPanel id={acceptedTaskId} />;
  if (!proposal) {
    return (
      <Card title="任务图" icon="graph">
        <p className="muted" data-testid="draft-graph-empty">这个会话还没有草稿；让主 Agent 先提案。</p>
      </Card>
    );
  }
  const tasks = view.tasks ?? [];
  return (
    <div className="stagger window-fill" data-testid="draft-graph-tab">
      <ConversationGraphBoard
        proposal={proposal}
        graph={graph}
        graphLoading={graphLoading}
        selectedNodeId={selectedNodeId}
        runtimeTaskId={acceptedTaskId}
        state={{
          taskCount: tasks.length,
          evidenceCount: (view.evidence ?? []).length,
          used: view.master?.used ?? 0,
          budget: view.master?.budget ?? null,
          ...(view.master?.unlimited === undefined ? {} : { unlimited: view.master.unlimited }),
          openQuestions: tasks.reduce((count, task) => count + (task.openQuestions?.length ?? 0), 0),
        }}
        onSelectNode={setSelectedNodeId}
      />
    </div>
  );
}
