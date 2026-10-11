/** Unconfirmed versions preview the proposal. Once accepted, this same window
 * shows the runtime GraphPanel and follows its revisions through completion. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { ConversationGraphBoard, type DraftGraph, type ProposalDetail } from './Conversation.tsx';
import { ErrorBox, useAsync, useEventStream } from './shared.tsx';
import { Card, Button, Spinner } from './ui.tsx';
import { GraphPanel } from './GraphPanel.tsx';

type ConversationView = {
  id: string;
  proposal: ProposalDetail | null;
  proposalHistory?: { version: number; summary: string; draftRevision?: number; draftDigest?: string }[];
  tasks: { id: string; status: string; used?: number | null; budget?: number | null; openQuestions?: unknown[] }[];
  evidence?: unknown[];
  accepted?: { proposalVersion: number; taskId: string }[];
  archivedProposals?: { version: number; summary: string; draftRevision?: number; draftDigest?: string }[];
  master?: { used: number; budget: number | null; unlimited?: boolean } | null;
};

export function DraftGraphTab({ conversationId, version }: { conversationId: string; version?: number }) {
  const { data: view, error, reload } = useAsync(() => api<ConversationView>(`/api/conversations/${conversationId}`), [conversationId]);
  const [actionError, setActionError] = useState('');
  async function act(action: () => Promise<unknown>) {
    setActionError('');
    try { await action(); reload(); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); }
  }
  const [graph, setGraph] = useState<DraftGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // The window names its own version, so it reads that version's proposal rather than whichever
  // one the conversation last drafted.
  const [chosen, setChosen] = useState<ProposalDetail | null>(null);
  const chosenGeneration = useRef(0);
  const graphGeneration = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEventStream(`/api/conversations/${conversationId}/events/stream`, () => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(reload, 150);
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const latest = view?.proposal ?? null;
  const selected = version ?? latest?.version ?? null;
  // The card the window is showing, wherever it currently lives: an in-place edit
  // keeps the version number, so the credential is what tells the preview to
  // reload, and a card that left both lists must drop its cached preview.
  const chosenCard = (view?.proposalHistory ?? []).find(item => item.version === selected)
    ?? (view?.archivedProposals ?? []).find(item => item.version === selected)
    ?? null;
  useEffect(() => {
    const mine = ++chosenGeneration.current;
    if (selected === null) { setChosen(null); return; }
    if (latest && latest.version === selected) { setChosen(latest); return; }
    if (view && !chosenCard) setChosen(null);
    let cancelled = false;
    void api<ProposalDetail>(`/api/conversations/${conversationId}/proposals/${selected}`)
      .then(payload => { if (!cancelled && mine === chosenGeneration.current) setChosen(payload); })
      .catch(() => { if (!cancelled && mine === chosenGeneration.current) setChosen(null); });
    return () => { cancelled = true; };
  }, [conversationId, selected, latest, chosenCard, view]);
  const proposal = chosen;
  const archivedCards = view?.archivedProposals ?? [];
  // If this draft has already been accepted, the board reads that task's live node states.
  const acceptedTaskId = view?.accepted?.find(item => item.proposalVersion === selected)?.taskId ?? null;
  const load = useCallback(async () => {
    // Invalidate first: an early return or an unmount must also drop any older
    // in-flight load, and an in-place edit of the same version must reload.
    const mine = ++graphGeneration.current;
    if (acceptedTaskId || selected === null) { setGraph(null); setGraphLoading(false); return; }
    setGraphLoading(true);
    try {
      const payload = await api<DraftGraph>(`/api/conversations/${conversationId}/draft-graph?version=${selected}`);
      if (mine !== graphGeneration.current) return;
      setGraph(payload);
    } catch { if (mine === graphGeneration.current) setGraph(null); }
    finally { if (mine === graphGeneration.current) setGraphLoading(false); }
  }, [conversationId, selected, acceptedTaskId, chosenCard?.draftRevision, chosenCard?.draftDigest]);
  useEffect(() => { void load(); return () => { graphGeneration.current += 1; }; }, [load]);

  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!view) return <Card><Spinner label="正在读取草稿…" /></Card>;
  if (acceptedTaskId) return (
    <div className="stagger window-fill" data-testid="draft-graph-tab">
      <GraphPanel id={acceptedTaskId} />
      {proposal && (
        <div className="row" data-testid="draft-window-actions">
          {!proposal.archived && (
            <Button size="sm" data-testid={`window-archive-draft-${proposal.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/archive`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, requestId: `archive-${crypto.randomUUID()}` }) }))}>归档源草稿</Button>
          )}
          {proposal.archived && (
            <Button size="sm" data-testid={`window-restore-draft-${proposal.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/restore`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, requestId: `restore-${crypto.randomUUID()}` }) }))}>恢复源草稿</Button>
          )}
          <Button size="sm" variant="danger" data-testid={`window-delete-draft-${proposal.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/delete`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, requestId: `delete-${crypto.randomUUID()}` }) }))}>删除源草稿</Button>
          {archivedCards.filter(item => item.version !== proposal.version).map(item => (
            <span key={item.version} className="row" data-testid={`window-archived-draft-${item.version}`}>
              <span className="muted">{`v${item.version} 已归档`}</span>
              <Button size="sm" data-testid={`window-restore-other-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/restore`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `restore-${crypto.randomUUID()}` }) }))}>恢复</Button>
              <Button size="sm" variant="danger" data-testid={`window-delete-archived-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/delete`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `delete-${crypto.randomUUID()}` }) }))}>删除</Button>
            </span>
          ))}
        </div>
      )}
      {actionError && <ErrorBox message={actionError} />}
    </div>
  );
  if (!proposal) {
    return (
      <Card title="任务图" icon="graph">
        <p className="muted" data-testid="draft-graph-empty">这个会话还没有草稿；让主 Agent 先提案。</p>
        {archivedCards.length > 0 && (
          <div data-testid="draft-window-archived">
            <p className="muted">已归档草稿（可恢复或删除）</p>
            {archivedCards.map(item => (
              <div key={item.version} className="row" data-testid={`window-archived-draft-${item.version}`}>
                <span className="grow">{`v${item.version} · ${item.summary}`}</span>
                <Button size="sm" data-testid={`window-restore-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/restore`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `restore-${crypto.randomUUID()}` }) }))}>恢复</Button>
                <Button size="sm" variant="danger" data-testid={`window-delete-archived-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/delete`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `delete-${crypto.randomUUID()}` }) }))}>删除</Button>
              </div>
            ))}
          </div>
        )}
        {actionError && <ErrorBox message={actionError} />}
      </Card>
    );
  }
  const tasks = view.tasks ?? [];
  return (
    <div className="stagger window-fill" data-testid="draft-graph-tab">
      <div className="row" data-testid="draft-window-actions">
        {!proposal.archived && (
          <Button size="sm" data-testid="window-archive-draft" onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/archive`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, requestId: `archive-${crypto.randomUUID()}` }) }))}>归档草稿</Button>
        )}
        <Button size="sm" variant="danger" data-testid="window-delete-draft" onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/delete`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, requestId: `delete-${crypto.randomUUID()}` }) }))}>删除草稿</Button>
        {proposal.archived && (
          <Button size="sm" data-testid="window-restore-draft" onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/restore`, { method: 'POST', body: JSON.stringify({ proposalVersion: proposal.version, requestId: `restore-${crypto.randomUUID()}` }) }))}>恢复当前草稿</Button>
        )}
        {archivedCards.filter(item => item.version !== proposal.version).map(item => (
          <Button key={item.version} size="sm" data-testid={`window-restore-draft-${item.version}`} onClick={() => void act(() => api(`/api/conversations/${conversationId}/drafts/restore`, { method: 'POST', body: JSON.stringify({ proposalVersion: item.version, requestId: `restore-${crypto.randomUUID()}` }) }))}>{`恢复 v${item.version}`}</Button>
        ))}
      </div>
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
      {actionError && <ErrorBox message={actionError} />}
    </div>
  );
}
