import { conversationActions } from "./conversation-actions.tsx";



import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react';


import { type AgentContextView } from './AgentContext.tsx';

import { api } from './api.ts';



import { type ChatAttachment } from './ChatComposer.tsx';


import {
cancelQueuedMessage,
composerPrimaryState,
readComposerDraft,
shouldScrollToLatest,
writeComposerDraft
} from './composer-state.ts';

import { usePreferences } from './preferences.ts';



import {
applyConversationEvent,
createConversationProjection,
observeConversationHistory,
observeConversationView,
type ConversationMessage
} from '../core/conversation-projection.ts';


import {
defaultDrawerOpen,
drawerInitPanelIds,
resolveDrawerSection,
type ConversationDrawerSection,
type DraftStatus
} from './conversation-drawer.ts';

import './conversation-drawer.css';




import { ErrorBox,useAsync,useEventStream,useTargetBranch } from './shared.tsx';


import { Spinner,toast } from './ui.tsx';

import { supervisorTranscript } from './supervisor-transcript.ts';

import type { ConversationView,DraftGraph,ProposalDetail,Settings } from "./conversation-types.tsx";
import { composerStorage,sentUserPrompts } from "./conversation-types.tsx";
import { useTranscriptFollow } from './use-transcript-follow.ts';

export function useConversationPanelState({ id, settings, onChanged, drawerOpen = defaultDrawerOpen(), onDrawerOpenChange }: {
  id: string;
  settings: Settings | null;
  onChanged?: () => void;
  drawerOpen?: boolean;
  onDrawerOpenChange: (open: boolean) => void;
}) {
  const { data: view, error, loading, reload } = useAsync(() => api<ConversationView>(`/api/conversations/${id}`), [id]);
  const { data: agentContext } = useAsync(
    () => api<AgentContextView>(`/api/agent-context?conversationId=${encodeURIComponent(id)}`),
    [id],
  );
  const [selectedProposalVersion, setSelectedProposalVersion] = useState<number | null>(null);
  const { data: selectedProposal } = useAsync(
    () => selectedProposalVersion
      ? api<ProposalDetail>(`/api/conversations/${id}/proposals/${selectedProposalVersion}`)
      : Promise.resolve(null),
    [id, selectedProposalVersion, view?.proposal?.draftRevision, view?.proposal?.draftDigest],
  );
  const { data: draftGraph, loading: draftGraphLoading } = useAsync(
    () => selectedProposalVersion
      ? api<DraftGraph>(`/api/conversations/${id}/draft-graph?version=${selectedProposalVersion}`)
      : Promise.resolve(null),
    [id, selectedProposalVersion, view?.proposal?.draftRevision, view?.proposal?.draftDigest],
  );
  const [text, setText] = useState(() => readComposerDraft(composerStorage(), id));
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [steering, setSteering] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [interruptPhase, setInterruptPhase] = useState<'idle' | 'interrupting' | 'accepted' | 'interrupted'>('idle');
  const [actionError, setActionError] = useState('');
  const [bindId, setBindId] = useState('');
  const { branch, setBranch } = useTargetBranch(settings?.projects ?? null, view?.projectId ?? null);
  const { preferences } = usePreferences();
  const [projection, setProjection] = useState(createConversationProjection);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderPending = useRef(false);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const [drawerSection, setDrawerSection] = useState<ConversationDrawerSection>('draft');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [pauseAction, setPauseAction] = useState<'pause' | 'resume' | null>(null);
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const [dismissedQueue, setDismissedQueue] = useState<string[]>([]);
  const busy = view?.master?.status === 'preparing' || view?.master?.status === 'running';
  const interruptTurn = useCallback(async () => {
    if (interrupting) return;
    setInterrupting(true);
    setInterruptPhase('interrupting');
    setActionError('');
    try {
      await api(`/api/conversations/${id}/interrupt`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `interrupt-${crypto.randomUUID()}` }),
      });
      setInterruptPhase('accepted');
      toast('已打断当前模型思考和工具调用。', 'info');
      reload();
      onChanged?.();
    } catch (reason) {
      setInterruptPhase('idle');
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setInterrupting(false);
    }
  }, [id, interrupting, onChanged, reload]);
  useEffect(() => {
    setInterruptPhase(current => {
      if (busy) {
        return current === 'interrupted' ? 'idle' : current;
      }
      return current === 'interrupting' || current === 'accepted' ? 'interrupted' : current;
    });
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      void interruptTurn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, interruptTurn]);
  const transcriptFollow = useTranscriptFollow(view?.id ?? null, Boolean(busy));
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => reload(), 150);
  }, [reload]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useEffect(() => { writeComposerDraft(composerStorage(), id, text); }, [id, text]);
  const connected = useEventStream(view ? `/api/conversations/${view.id}/events/stream` : null, event => {
    const data = event.data as Parameters<typeof applyConversationEvent>[1]['data'];
    setProjection(current => applyConversationEvent(current, { type: event.type, cursor: event.cursor, ...(data ? { data } : {}) }));
    if (event.type !== 'message.delta') refresh();
  }, view?.eventCursor ?? 0);
  useEffect(() => {
    const latest = view?.accepted.at(-1);
    if (latest?.targetBranch) setBranch(latest.targetBranch);
  }, [view?.accepted]);
  useEffect(() => {
    setPauseAction(null);
    setPausedOverride(null);
    setDismissedQueue([]);
    setInterruptPhase('idle');
  }, [id]);
  useEffect(() => {
    if (view && pausedOverride !== null && view.paused === pausedOverride) setPausedOverride(null);
  }, [view, pausedOverride]);
  useEffect(() => {
    const active = view?.proposalHistory ?? [];
    setSelectedProposalVersion(current => {
      if (current !== null && active.some(item => item.version === current)) return current;
      return view?.proposal?.version ?? active[0]?.version ?? null;
    });
  }, [view?.proposal?.version, view?.proposal?.draftRevision, view?.proposalHistory]);
  useEffect(() => {
    setSelectedGraphNodeId(null);
  }, [selectedProposalVersion]);
  useEffect(() => {
    if (!view || !drawerOpen) return;
    const activeDraft = Boolean(view.proposal && !view.accepted.some(item => item.proposalVersion === view.proposal!.version));
    const draftCards = activeDraft || (view.archivedProposals ?? []).length > 0;
    const resolved = resolveDrawerSection({
      current: drawerSection,
      selectedTaskId,
      taskIds: view.tasks.map(task => task.id),
    });
    if (activeDraft) resolved.section = 'draft';
    else if (!draftCards) resolved.section = 'task';
    if (resolved.section !== drawerSection) setDrawerSection(resolved.section);
    if (resolved.taskId !== selectedTaskId) setSelectedTaskId(resolved.taskId);
  }, [view, drawerOpen, drawerSection, selectedTaskId]);
  useEffect(() => {
    if (view) setProjection(current => observeConversationView(current, view));
  }, [view]);
  const transcript = useMemo(() => supervisorTranscript(projection, {
    busy: Boolean(busy),
    continuations: view?.continuations ?? [],
  }), [projection, busy, view?.continuations]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const thread = transcriptFollow.threadRef.current;
    if (!anchor || !thread) return;
    thread.scrollTop = anchor.top + thread.scrollHeight - anchor.height;
    historyAnchor.current = null;
  }, [transcript.messages]);
  const composerHistory = useMemo(() => sentUserPrompts(transcript.messages), [transcript.messages]);
  useEffect(() => {
    if (transcript.streamNeedsResync) reload();
  }, [reload, transcript.streamNeedsResync]);
  const enteredScrollRef = useRef(false);
  useEffect(() => {
    const jump = shouldScrollToLatest({
      tab: 'chat',
      hasMessages: transcript.messages.length > 0,
      alreadyJumped: enteredScrollRef.current,
    });
    if (!jump) return;
    enteredScrollRef.current = true;
    const frame = requestAnimationFrame(() => transcriptFollow.scrollToLatest('auto'));
    return () => cancelAnimationFrame(frame);
  }, [transcript.messages.length, transcriptFollow.scrollToLatest]);
  if (loading && !view) return { fallback: <div role="status" className="conversation-loading"><Spinner label="正在加载会话…" /></div> };
  if (error && !view) return { fallback: <ErrorBox message={error} onRetry={reload} /> };
  if (!view) return { fallback: <div role="status" className="conversation-loading"><Spinner label="正在加载会话…" /></div> };

  const acceptedVersions = new Set(view.accepted.map(item => item.proposalVersion));
  const proposal = view.proposal;
  const confirmable = Boolean(proposal && !proposal.stale && !acceptedVersions.has(proposal.version));
  const paused = pausedOverride ?? view.paused;
  const queuedMessages = dismissedQueue.reduce(
    (list, messageId) => cancelQueuedMessage(list, messageId),
    transcript.queuedMessages,
  );
  const hasComposerInput = Boolean(text.trim() || attachments.length);
  const primaryState = composerPrimaryState({
    busy: Boolean(busy),
    paused,
    pending: pauseAction !== null,
    hasInput: hasComposerInput,
    queueLength: queuedMessages.length,
  });

  const { act, changePaused, send, steerQueued, submitEnter, submitPrimary, cancelQueued, selectMasterModel, compactConversation } = conversationActions({ setActionError, reload, onChanged, pauseAction, setPauseAction, id, setPausedOverride, text, agentContext, attachments, setText, setAttachments, setSending, transcriptFollow, steering, interrupting, queuedMessages, setSteering, sending, busy, primaryState, hasComposerInput, setDismissedQueue });

  const masterQuestions = (view.questions ?? []).filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user');
  const interruptStatus: string | null = interruptPhase === 'interrupted'
    ? '已打断'
    : interruptPhase === 'idle' ? null : '打断中';
  async function loadOlder() {
    if (olderPending.current) return;
    const request = transcript.historyRequest;
    if (!request) return;
    olderPending.current = true;
    setLoadingOlder(true);
    setActionError('');
    try {
      const page = await api<{ messages: ConversationMessage[] }>(
        `/api/conversations/${id}/history?${request.direction}=${request.cursor}&limit=200`,
      );
      const thread = transcriptFollow.threadRef.current;
      if (thread && request.direction === 'before') historyAnchor.current = { height: thread.scrollHeight, top: thread.scrollTop };
      setProjection(current => observeConversationHistory(current, { request, messages: page.messages }));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      olderPending.current = false;
      setLoadingOlder(false);
    }
  }
  const tasks = view.tasks;
  const taskQuestions = tasks.filter(task => task.openQuestions.length > 0);
  const detailTask = tasks.find(task => task.id === selectedTaskId) ?? tasks[0] ?? null;
  const proposalHistory = view.proposalHistory ?? [];
  const activeProposal = selectedProposalVersion !== null && selectedProposalVersion === proposal?.version
    ? proposal
    : selectedProposal;
  const activeProposalSummary = proposalHistory.find(item => item.version === selectedProposalVersion) ?? null;
  const drawerLoading = drawerSection === 'draft' && Boolean(proposal || activeProposalSummary) && !activeProposal;
  const draftStatus: DraftStatus = !proposal
    ? 'none'
    : acceptedVersions.has(proposal.version)
      ? 'accepted'
      : proposal.stale
        ? 'stale'
        : 'pending';
  const confirmableForActive = Boolean(activeProposal && proposal && activeProposal.version === proposal.version && confirmable);
  const activeAccepted = Boolean(activeProposal && acceptedVersions.has(activeProposal.version));
  const activeStale = Boolean(activeProposal && activeProposal.stale && !activeAccepted);
  const managementCards = proposalHistory.filter(item => !(drawerSection === 'draft' && item.version === activeProposal?.version));
  const hasDrawerContent = drawerSection === 'draft'
    ? Boolean(activeProposal) || (view.archivedProposals ?? []).length > 0
    : Boolean(detailTask);
  const activeProposalVersion = selectedProposalVersion ?? activeProposal?.version ?? null;
  const graphRuntimeTaskId = activeProposalVersion === null
    ? null
    : view.accepted.find(item => item.proposalVersion === activeProposalVersion)?.taskId ?? null;
  const graphState = {
    taskCount: tasks.length,
    evidenceCount: tasks.reduce((count, task) => count + task.evidence.filter(item => item.valid).length, 0),
    used: view.usage.used,
    budget: view.usage.budget,
    unlimited: Boolean(view.usage.unlimited),
    openQuestions: masterQuestions.length + tasks.reduce((count, task) => count + task.openQuestions.length, 0),
  };
  function openDrawerRoot() {
    const archived = (view?.archivedProposals ?? []).length > 0;
    if (archived || (proposal && !acceptedVersions.has(proposal.version))) {
      setDrawerSection('draft');
    } else {
      setDrawerSection('task');
      if (tasks[0]) setSelectedTaskId(tasks[0].id);
    }
    onDrawerOpenChange(true);
  }
  const entryState = {
    proposalVersion: proposal?.version ?? null,
    draftStatus,
    taskCount: tasks.length,
    projectBound: Boolean(view.projectId),
  };
  const deferredInitPanelIds = drawerInitPanelIds();
  return { fallback: null, sending, steering, interruptStatus, view, busy, paused, connected, drawerOpen, draftStatus, tasks, onDrawerOpenChange, openDrawerRoot, entryState, proposal, acceptedVersions, transcriptFollow, loadOlder, transcript, loadingOlder, preferences, actionError, queuedMessages, cancelQueued, masterQuestions, taskQuestions, reload, onChanged, text, setText, attachments, setAttachments, agentContext, settings, selectMasterModel, compactConversation, submitPrimary, submitEnter, composerHistory, Boolean, pauseAction, hasComposerInput, drawerSection, deferredInitPanelIds, bindId, setBindId, act, id, activeProposal, activeStale, activeAccepted, confirmableForActive, branch, setBranch, setSelectedProposalVersion, selectedProposalVersion, proposalHistory, managementCards, drawerLoading, selectedTaskId, setSelectedTaskId, hasDrawerContent };
}
