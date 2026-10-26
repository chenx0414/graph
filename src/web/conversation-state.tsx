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
visibleTranscriptMessages,
writeComposerDraft
} from './composer-state.ts';

import { usePreferences,visibleSuggestion } from './preferences.ts';



import {
applyConversationEvent,
conversationProjectionSnapshot,
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

import { buildTranscriptRows } from './transcript-model.ts';

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
    // The credential is part of the identity of a draft: editing the same version
    // in place must re-read the preview instead of showing the previous content.
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
    setActionError('');
    try {
      await api(`/api/conversations/${id}/interrupt`, {
        method: 'POST',
        body: JSON.stringify({ requestId: `interrupt-${crypto.randomUUID()}` }),
      });
      toast('已打断当前模型思考和工具调用。', 'info');
      reload();
      onChanged?.();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setActionError(message);
      toast(message, 'danger');
    } finally {
      setInterrupting(false);
    }
  }, [id, interrupting, onChanged, reload]);
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
    // One event usually means several records changed; coalesce the refetches.
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
  }, [id]);
  useEffect(() => {
    if (view && pausedOverride !== null && view.paused === pausedOverride) setPausedOverride(null);
  }, [view, pausedOverride]);
  useEffect(() => {
    // Selecting a card that is no longer active (archived or deleted) must not
    // survive a reload: fall back to the current draft, then to the newest active
    // card.
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
    // The draft page owns its cards whether they are active or archived, so only
    // an empty draft page falls back to the task section. A page that still has
    // something to manage stays where the user put it.
    const activeDraft = Boolean(view.proposal && !view.accepted.some(item => item.proposalVersion === view.proposal!.version));
    const draftCards = activeDraft || (view.archivedProposals ?? []).length > 0;
    const resolved = resolveDrawerSection({
      current: drawerSection,
      selectedTaskId,
      taskIds: view.tasks.map(task => task.id),
    });
    // A live draft always surfaces, so an overturned draft replaces the old one on
    // screen. Archived-only content must not hijack the task section (the entry
    // point for it is openDrawerRoot), and nothing else overrides the user choice.
    if (activeDraft) resolved.section = 'draft';
    else if (!draftCards) resolved.section = 'task';
    if (resolved.section !== drawerSection) setDrawerSection(resolved.section);
    if (resolved.taskId !== selectedTaskId) setSelectedTaskId(resolved.taskId);
  }, [view, drawerOpen, drawerSection, selectedTaskId]);
  useEffect(() => {
    if (view) setProjection(current => observeConversationView(current, view));
  }, [view]);
  const snapshot = useMemo(() => conversationProjectionSnapshot(projection, { busy: Boolean(busy) }), [projection, busy]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const thread = transcriptFollow.threadRef.current;
    if (!anchor || !thread) return;
    thread.scrollTop = anchor.top + thread.scrollHeight - anchor.height;
    historyAnchor.current = null;
  }, [snapshot.messages]);
  const displayMessages = useMemo(() => visibleTranscriptMessages(snapshot.messages), [snapshot.messages]);
  const composerHistory = useMemo(() => sentUserPrompts(displayMessages), [displayMessages]);
  const transcriptRows = useMemo(() => buildTranscriptRows({
    messages: displayMessages,
    continuations: view?.continuations ?? [],
    liveTools: snapshot.liveTools,
    streaming: snapshot.streaming,
    busy: Boolean(busy),
  }), [displayMessages, view?.continuations, snapshot.liveTools, snapshot.streaming, busy]);
  useEffect(() => {
    if (snapshot.streamNeedsResync) reload();
  }, [reload, snapshot.streamNeedsResync]);
  // Entering a conversation (or reopening the window) starts at the newest
  // message once the transcript window has rendered. Leaving and re-entering
  // the chat tab re-arms the jump without yanking a reader on new arrivals.
  const enteredScrollRef = useRef(false);
  useEffect(() => {
    const jump = shouldScrollToLatest({
      tab: 'chat',
      hasMessages: snapshot.messages.length > 0,
      alreadyJumped: enteredScrollRef.current,
    });
    if (!jump) return;
    enteredScrollRef.current = true;
    const frame = requestAnimationFrame(() => transcriptFollow.scrollToLatest('auto'));
    return () => cancelAnimationFrame(frame);
  }, [snapshot.messages.length, transcriptFollow.scrollToLatest]);
  if (loading && !view) return { fallback: <div role="status" className="conversation-loading"><Spinner label="正在加载会话…" /></div> };
  if (error && !view) return { fallback: <ErrorBox message={error} onRetry={reload} /> };
  if (!view) return { fallback: <div role="status" className="conversation-loading"><Spinner label="正在加载会话…" /></div> };

  const acceptedVersions = new Set(view.accepted.map(item => item.proposalVersion));
  const proposal = view.proposal;
  const confirmable = Boolean(proposal && !proposal.stale && !acceptedVersions.has(proposal.version));
  const paused = pausedOverride ?? view.paused;
  const queuedMessages = dismissedQueue.reduce(
    (list, messageId) => cancelQueuedMessage(list, messageId),
    snapshot.queuedMessages,
  );
  // Candidate prompts are an opt-in preference; when off, the composer never
  // shows (nor sends) a suggested next prompt.
  const promptSuggestion = visibleSuggestion(preferences, snapshot.promptSuggestion);
  const hasComposerInput = Boolean(text.trim() || attachments.length);
  const primaryState = composerPrimaryState({
    busy: Boolean(busy),
    paused,
    pending: pauseAction !== null,
    hasInput: hasComposerInput,
    queueLength: queuedMessages.length,
    hasSuggestion: Boolean(promptSuggestion),
  });

  const { act, changePaused, send, steerQueued, submitEnter, submitPrimary, cancelQueued, selectMasterModel, compactConversation } = conversationActions({ setActionError, reload, onChanged, pauseAction, setPauseAction, id, setPausedOverride, text, agentContext, attachments, setText, setAttachments, setSending, transcriptFollow, steering, interrupting, queuedMessages, setSteering, sending, busy, promptSuggestion, primaryState, hasComposerInput, setDismissedQueue });

  const masterQuestions = (view.questions ?? []).filter(question => question.status === 'open' && (question.owner ?? 'user') === 'user');
  async function loadOlder() {
    if (olderPending.current) return;
    const request = snapshot.historyRequest;
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
  // A confirmed card is confirmed, not stale. Confirming advances the anchor's
  // requirement, so the source card is stale by construction afterwards; reading
  // staleness first would label it "re-discuss" and invite a second graph for a task
  // that already has one. Execution changes go to the original graph instead.
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
  /** The header entry: one click opens the drawer on the draft, or on the first
   * task when there is no draft to show. */
  function openDrawerRoot() {
    // The draft page owns the draft cards, including the archived ones: with every
    // card archived there is still something to see and restore, so the task
    // section must not swallow it.
    const archived = (view?.archivedProposals ?? []).length > 0;
    if (archived || (proposal && !acceptedVersions.has(proposal.version))) {
      setDrawerSection('draft');
    } else {
      // No draft to show: the drawer opens on the task section, which always has something to
      // offer - the shared artifacts exist whether or not a task does.
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
  // The initialization panels (empty task list, project binding) are declared by
  // the policy module; the view only renders what the policy places in the drawer.
  const deferredInitPanelIds = drawerInitPanelIds();
  return { fallback: null, sending, steering, view, busy, paused, connected, drawerOpen, draftStatus, tasks, onDrawerOpenChange, openDrawerRoot, entryState, proposal, acceptedVersions, transcriptFollow, loadOlder, snapshot, loadingOlder, transcriptRows, preferences, actionError, queuedMessages, cancelQueued, masterQuestions, taskQuestions, reload, onChanged, text, setText, attachments, setAttachments, promptSuggestion, agentContext, settings, selectMasterModel, compactConversation, submitPrimary, submitEnter, composerHistory, Boolean, pauseAction, hasComposerInput, drawerSection, deferredInitPanelIds, bindId, setBindId, act, id, activeProposal, activeStale, activeAccepted, confirmableForActive, branch, setBranch, setSelectedProposalVersion, selectedProposalVersion, proposalHistory, managementCards, drawerLoading, selectedTaskId, setSelectedTaskId, hasDrawerContent };
}
