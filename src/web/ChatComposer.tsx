import { MarkdownInput } from './MarkdownInput.tsx';
import { usePreferences } from './preferences.ts';
import { attachmentImageSource } from './attachments.ts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { insertAtCaret, readClipboardText } from './chat-paste.ts';
import {
  composerHistoryDown,
  composerHistoryUp,
  createComposerHistoryState,
  resetComposerHistory,
  submitComposerPrompt,
  type ComposerHistoryState,
} from './chat-history.ts';
import {
  composerEditKind,
  createComposerUndoState,
  recordComposerEdit,
  redoComposer,
  undoComposer,
} from './chat-undo.ts';
import { clampComposerHeight, composerPrimaryState } from './composer-state.ts';
import {
  addComposerAttachment,
  attachmentSize,
  buildAttachment,
  isImageAttachment,
  rejectionNotices,
  removeComposerAttachment,
  validateAttachment,
  type AttachmentCandidate,
  type AttachmentResult,
  type ChatAttachment,
} from './attachments.ts';
import { FullAccessToggle } from './FullAccessToggle.tsx';
import type { AgentCapabilityView, AgentToolView } from './AgentContext.tsx';
import type { ComposerModel, ComposerTelemetryView, ThinkingLevel } from './ComposerTelemetry.tsx';
import { thinkingView } from './thinking-levels.ts';
import {
  filterSlashEntries,
  slashTargetToken,
  slashEntries,
  SlashMenu,
  type SlashEntry,
  type SlashScope,
} from './SlashCommands.tsx';
import { Icon, toast } from './ui.tsx';

export type { ChatAttachment } from './attachments.ts';
type MentionEntry = { path: string; kind: 'file' | 'directory' };
type Mention = { start: number; end: number; query: string };
type Slash = { start: number; end: number; query: string };

/** Read a dropped/pasted file as a local DataURL (image preview + base64). */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read error'));
    reader.readAsDataURL(file);
  });
}

function mentionAt(value: string, cursor: number): Mention | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor));
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: cursor - query.length - 1, end: cursor, query };
}

function slashAt(value: string, cursor: number): Slash | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(value.slice(0, cursor));
  if (!match) return null;
  const query = match[1] ?? '';
  const start = cursor - query.length - 1;
  if (start < 0) return null;
  return { start, end: cursor, query };
}

export function ChatComposer({
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  projectId,
  placeholder,
  onSend,
  onSubmit,
  sendDisabled,
  busy = false,
  paused = false,
  pausePending = false,
  queueLength = 0,
  hasSuggestion = false,
  history,
  suggestion,
  slashTools = [],
  slashCapabilities = [],
  slashModels = [],
  slashTelemetry,
  onSlashModelSelect,
  onCompact,
  leftActions,
  className = '',
  autoFocus = false,
  inputTestId = 'chat-input',
  sendTestId = 'chat-send',
  attachTestId = 'chat-attach',
  attachmentInputTestId = 'chat-attachment-input',
}: {
  value: string;
  onChange: (value: string) => void;
  attachments: ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  projectId: string | null;
  placeholder: string;
  onSend: () => void;
  /** Enter key action. Defaults to `onSend`; used to keep keyboard sending
   * separate from the context-sensitive primary button. */
  onSubmit?: () => void;
  sendDisabled: boolean;
  /** The master is producing output, so the primary button offers pause. */
  busy?: boolean;
  /** The conversation is paused, so the primary button resumes or sends+resumes. */
  paused?: boolean;
  /** A pause/resume request is in flight; the primary button waits. */
  pausePending?: boolean;
  /** Queued messages, for the idle steering branch of the primary control. */
  queueLength?: number;
  /** A suggested prompt is available, for the idle send branch. */
  hasSuggestion?: boolean;
  /**
   * The conversation's already-sent user prompts, oldest first. When omitted the
   * composer recalls only the prompts it sent itself during this session.
   */
  history?: string[];
  suggestion?: string | null;
  slashTools?: AgentToolView[];
  slashCapabilities?: AgentCapabilityView[];
  slashModels?: ComposerModel[];
  slashTelemetry?: ComposerTelemetryView | undefined;
  onSlashModelSelect?: (model: ComposerModel, thinkingLevel: ThinkingLevel) => Promise<void> | void;
  onCompact?: () => Promise<void> | void;
  leftActions?: ReactNode;
  className?: string;
  autoFocus?: boolean;
  inputTestId?: string;
  sendTestId?: string;
  attachTestId?: string;
  attachmentInputTestId?: string;
}) {
  const [cursor, setCursor] = useState(value.length);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionEntries, setMentionEntries] = useState<MentionEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashScope, setSlashScope] = useState<SlashScope>('root');
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashLayout, setSlashLayout] = useState<{ placement: 'up' | 'down'; maxHeight: number }>({
    placement: 'up',
    maxHeight: 340,
  });
  const [dragging, setDragging] = useState(false);
  const [attachmentNotices, setAttachmentNotices] = useState<string[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const { preferences } = usePreferences();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // An explicit snapshot stack: React writes the textarea value programmatically,
  // so the browser's native undo has nothing to replay.
  const undoRef = useRef(createComposerUndoState());
  const historyRef = useRef(createComposerHistoryState());
  const [historyBrowsing, setHistoryBrowsing] = useState(false);
  const activeMention = mentionAt(value, cursor);
  const activeSlash = slashAt(value, cursor);
  const allSlashEntries = useMemo(() => slashEntries({
    scope: slashScope,
    tools: slashTools,
    capabilities: slashCapabilities,
    models: slashModels,
    telemetry: slashTelemetry,
    canCompact: Boolean(onCompact),
    compactDisabled: false,
  }), [slashScope, slashTools, slashCapabilities, slashModels, slashTelemetry, onCompact]);
  const visibleSlashEntries = useMemo(
    () => filterSlashEntries(allSlashEntries, activeSlash?.query ?? ''),
    [allSlashEntries, activeSlash?.query],
  );
  const availableSuggestion = suggestion?.trim() ?? '';
  const showingSuggestion = Boolean(availableSuggestion) && value.length === 0
    && attachments.length === 0 && !mentionOpen && !slashOpen;
  const primaryMode = composerPrimaryState({
    busy, paused, pending: pausePending,
    hasInput: Boolean(value.trim() || attachments.length),
    queueLength, hasSuggestion,
  }).mode;
  const primaryLabel = primaryMode === 'pending'
    ? '正在切换暂停状态…'
    : primaryMode === 'pause'
      ? '暂停主 Agent 的对话处理'
      : primaryMode === 'resume'
        ? '继续对话；输入内容时发送并继续'
        : '发送消息';

  /** Record a user edit so ⌘Z / ⇧⌘Z can step over it. */
  function rememberEdit(previous: string, next: string) {
    if (previous === next) return;
    undoRef.current = recordComposerEdit(undoRef.current, previous, next, composerEditKind(previous, next));
  }

  /** Prompts available to ↑/↓: the conversation's sent messages, else this session's. */
  function historyState(): ComposerHistoryState {
    return history === undefined ? historyRef.current : { ...historyRef.current, entries: history };
  }

  function leaveHistory() {
    historyRef.current = resetComposerHistory(historyRef.current);
    setHistoryBrowsing(false);
  }

  /** Put a value in the box without treating it as a user edit (undo, recall). */
  function applyProgrammatic(next: string) {
    onChange(next);
    const caret = next.length;
    setCursor(caret);
    setMentionOpen(false);
    setSlashOpen(false);
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      target?.focus();
      target?.setSelectionRange(caret, caret);
    });
  }

  /**
   * Submit = always leave the browsing position. Only when the composer owns the
   * list does it also remember the prompt; a parent-owned list is updated from
   * the conversation's transcript instead.
   */
  function rememberPrompt() {
    historyRef.current = submitComposerPrompt(historyRef.current, value, history !== undefined);
    setHistoryBrowsing(false);
  }


  useEffect(() => {
    const mention = mentionAt(value, cursor);
    if (!mentionOpen || !mention || !projectId) {
      setMentionEntries([]);
      setMentionLoading(false);
      return;
    }
    let cancelled = false;
    setMentionLoading(true);
    const timer = setTimeout(() => {
      void api<{ entries: MentionEntry[] }>(`/api/projects/${encodeURIComponent(projectId)}/entries?q=${encodeURIComponent(mention.query)}&limit=40`)
        .then(result => {
          if (cancelled) return;
          setMentionEntries(result.entries);
          setMentionIndex(0);
        })
        .catch(() => { if (!cancelled) setMentionEntries([]); })
        .finally(() => { if (!cancelled) setMentionLoading(false); });
    }, 100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mentionOpen, value, cursor, projectId]);

  useEffect(() => {
    if (!slashOpen) return;
    const active = visibleSlashEntries.find(entry => !entry.disabled);
    setSlashIndex(current => {
      if (!visibleSlashEntries.length) return 0;
      if (visibleSlashEntries[current] && !visibleSlashEntries[current]!.disabled) return current;
      return active ? visibleSlashEntries.indexOf(active) : 0;
    });
  }, [slashOpen, visibleSlashEntries]);

  useLayoutEffect(() => {
    if (!slashOpen) return;
    const update = () => {
      const rect = composerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 12;
      const above = Math.max(0, rect.top - gap);
      const below = Math.max(0, window.innerHeight - rect.bottom - gap);
      const placement = below > above ? 'down' : 'up';
      setSlashLayout({
        placement,
        maxHeight: Math.max(80, Math.min(480, Math.max(above, below))),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [slashOpen]);

  async function addAttachments(files: File[]) {
    let next = [...attachments];
    const results: AttachmentResult[] = [];
    for (const file of files) {
      const candidate: AttachmentCandidate = { name: file.name, type: file.type, size: file.size };
      const decision = validateAttachment(candidate, next);
      if (!decision.ok) { results.push({ name: file.name, accepted: false, reason: decision.reason }); continue; }
      try {
        const content = decision.kind === 'image'
          ? { dataUrl: await readFileAsDataUrl(file) }
          : { text: await file.text() };
        const built = buildAttachment(candidate, content);
        if (!built.ok) { results.push({ name: file.name, accepted: false, reason: built.reason }); continue; }
        next = addComposerAttachment(next, built.attachment);
        results.push({ name: file.name, accepted: true });
      } catch {
        results.push({ name: file.name, accepted: false, reason: '无法读取文件' });
      }
    }
    onAttachmentsChange(next);
    // A visible, per-file reason for everything that was rejected. A later add
    // with nothing rejected (or sending) clears the notices again.
    setAttachmentNotices(rejectionNotices(results));
  }

  /** Attach pasted files (images) and keep the plain-text paste untouched. */
  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text') ?? '';
    if (pastedText) {
      const input = event.currentTarget;
      const start = input.selectionStart ?? cursor;
      const end = input.selectionEnd ?? cursor;
      const inserted = insertAtCaret({ value, start, end, text: pastedText });
      if (inserted.value !== value) {
        rememberEdit(value, inserted.value);
        leaveHistory();
        onChange(inserted.value);
        setCursor(inserted.caret);
      }
    }
    void addAttachments(files);
  }

  async function pasteClipboardAtCaret(input: HTMLTextAreaElement | null) {
    const currentValue = input?.value ?? value;
    const start = input?.selectionStart ?? cursor;
    const end = input?.selectionEnd ?? cursor;
    const read = await readClipboardText(
      typeof navigator !== 'undefined' && navigator.clipboard
        ? () => navigator.clipboard.readText()
        : undefined,
    );
    // An empty clipboard stays silent (nothing to paste); a blocked read is a capability problem the
    // user can act on, so it is reported instead of looking like a paste that did nothing.
    if (!read.text) {
      if (read.blocked) toast('读不到剪贴板：请在系统设置里允许剪贴板访问，或按 Cmd+V 粘贴', 'danger');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const next = insertAtCaret({ value: currentValue, start, end, text: read.text });
    rememberEdit(currentValue, next.value);
    leaveHistory();
    onChange(next.value);
    setCursor(next.caret);
    const slash = slashAt(next.value, next.caret);
    setMentionOpen(Boolean(mentionAt(next.value, next.caret)));
    setSlashOpen(Boolean(slash));
    if (slash) {
      setSlashScope('root');
      setSlashIndex(0);
    }
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      target?.focus();
      target?.setSelectionRange(next.caret, next.caret);
    });
  }

  function chooseMention(entry: MentionEntry) {
    const mention = mentionAt(value, cursor);
    if (!mention) return;
    const token = `@${entry.path}${entry.kind === 'directory' ? '/' : ' '}`;
    const next = `${value.slice(0, mention.start)}${token}${value.slice(mention.end)}`;
    const nextCursor = mention.start + token.length;
    rememberEdit(value, next);
    leaveHistory();
    onChange(next);
    setCursor(nextCursor);
    setMentionIndex(0);
    setMentionOpen(entry.kind === 'directory');
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function clearSlashToken() {
    const slash = slashAt(value, cursor);
    if (!slash) return cursor;
    const next = `${value.slice(0, slash.start)}${value.slice(slash.end)}`.replace(/[ \t]+$/, '');
    const nextCursor = Math.min(slash.start, next.length);
    rememberEdit(value, next);
    leaveHistory();
    onChange(next);
    setCursor(nextCursor);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
    return nextCursor;
  }

  async function chooseSlash(entry: SlashEntry) {
    if (entry.disabled) return;
    try {
      if (entry.action.type === 'open-model' || entry.action.type === 'open-thinking') {
        clearSlashToken();
        setSlashScope(entry.action.type === 'open-model' ? 'model' : 'thinking');
        setSlashIndex(0);
        setSlashOpen(true);
        return;
      }
      if (entry.action.type === 'tool' || entry.action.type === 'capability') {
        const target = entry.action.target;
        setSlashOpen(false);
        setSlashScope('root');
        requestAnimationFrame(() => {
          const currentValue = textareaRef.current?.value ?? value;
          const selection = textareaRef.current?.selectionStart ?? currentValue.length;
          const slashAtSelection = slashAt(currentValue, selection);
          const currentCursor = slashAtSelection ? selection : currentValue.length;
          const slash = slashAtSelection ?? slashAt(currentValue, currentCursor);
          const start = slash?.start ?? currentCursor;
          const end = slash?.end ?? currentCursor;
          const token = `${slashTargetToken(target)} `;
          const next = `${currentValue.slice(0, start)}${token}${currentValue.slice(end)}`;
          const nextCursor = start + token.length;
          rememberEdit(currentValue, next);
          leaveHistory();
          onChange(next);
          setCursor(nextCursor);
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
        });
        return;
      }
      clearSlashToken();
      setSlashOpen(false);
      setSlashScope('root');
      if (entry.action.type === 'compact') {
        await onCompact?.();
        return;
      }
      if (entry.action.type === 'model') {
        const currentLevel = (slashTelemetry?.thinkingLevel ?? 'off') as ThinkingLevel;
        await onSlashModelSelect?.(entry.action.model, thinkingView(entry.action.model, currentLevel).level as ThinkingLevel);
        return;
      }
      if (entry.action.type === 'thinking') {
        const model = slashModels.find(item => item.id === slashTelemetry?.model);
        if (model) await onSlashModelSelect?.(model, entry.action.level);
      }
    } catch (reason) {
      toast(`命令执行失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    }
  }

  return (
    <div
      className={`chat-composer ${className}`}
      ref={composerRef}
      data-dragging={dragging}
      onDragOver={event => {
        if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) void addAttachments(files);
      }}
    >
      {slashOpen && (
        <SlashMenu
          scope={slashScope}
          entries={visibleSlashEntries}
          query={activeSlash?.query ?? ''}
          activeIndex={slashIndex}
          placement={slashLayout.placement}
          maxHeight={slashLayout.maxHeight}
          onChoose={entry => void chooseSlash(entry)}
          onBack={() => {
            clearSlashToken();
            setSlashScope('root');
            setSlashIndex(0);
            setSlashOpen(true);
          }}
        />
      )}
      {mentionOpen && activeMention && (
        <div className="mention-popover" data-testid="mention-popover">
          <div className="mention-popover-head">
            <span>项目文件与文件夹</span>
            <span className="faint">@ {activeMention.query || '全部'}</span>
          </div>
          {!projectId ? (
            <div className="mention-empty">当前对话未绑定项目</div>
          ) : mentionLoading ? (
            <div className="mention-empty">正在读取项目路径…</div>
          ) : mentionEntries.length ? (
            <div className="mention-list" role="listbox">
              {mentionEntries.map((entry, index) => (
                <button
                  key={`${entry.kind}:${entry.path}`}
                  type="button"
                  className="mention-item"
                  data-active={mentionIndex === index}
                  role="option"
                  aria-selected={mentionIndex === index}
                  data-testid={`mention-${entry.kind}-${entry.path}`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => chooseMention(entry)}
                >
                  <Icon name={entry.kind === 'directory' ? 'folder' : 'file'} size={14} />
                  <span className="grow truncate">{entry.path}{entry.kind === 'directory' ? '/' : ''}</span>
                  <span className="faint">{entry.kind === 'directory' ? '文件夹' : '文件'}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mention-empty">没有匹配的项目路径</div>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments" data-testid="composer-attachments">
          {attachments.map(attachment => (
            <span className="composer-attachment" data-kind={isImageAttachment(attachment) ? 'image' : 'text'} key={`${attachment.name}:${attachment.size}`}>
              {isImageAttachment(attachment) && (attachment.preview || attachmentImageSource(attachment))
                ? <img className="composer-attachment-preview" src={attachment.preview || attachmentImageSource(attachment)} alt={attachment.name} />
                : <Icon name="paperclip" size={12} />}
              <span className="truncate">{attachment.name}</span>
              <span className="faint">{attachmentSize(attachment.size)}</span>
              <button type="button" onClick={() => onAttachmentsChange(removeComposerAttachment(attachments, attachment))} aria-label={`移除附件 ${attachment.name}`}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachmentNotices.length > 0 && (
        <div className="composer-notices" data-testid="composer-attachment-notices" role="alert" aria-live="polite">
          {attachmentNotices.map(notice => (
            <div className="composer-notice" key={notice}>
              <Icon name="alert" size={12} />
              <span>{notice}</span>
            </div>
          ))}
        </div>
      )}
      <MarkdownInput
        live={preferences.markdownRendering}
        ref={textareaRef}
        data-testid={inputTestId}
        data-history={historyBrowsing ? 'browsing' : undefined}
        value={value}
        onChange={event => {
          const next = event.target.value;
          const position = event.target.selectionStart ?? next.length;
          rememberEdit(value, next);
          leaveHistory();
          onChange(next);
          setCursor(position);
          setMentionOpen(Boolean(mentionAt(next, position)));
          setSlashOpen(Boolean(slashAt(next, position)));
          if (slashAt(next, position)) {
            setSlashScope('root');
            setSlashIndex(0);
          }
        }}
        onSelect={event => setCursor(event.currentTarget.selectionStart ?? value.length)}
        onClick={event => setCursor(event.currentTarget.selectionStart ?? value.length)}
        onPaste={handlePaste}
        onContextMenu={event => {
          // Paste the clipboard at the caret instead of opening any menu.
          event.preventDefault();
          void pasteClipboardAtCaret(event.currentTarget);
        }}
        placeholder={showingSuggestion ? availableSuggestion : placeholder}
        data-suggestion={showingSuggestion ? availableSuggestion : undefined}
        autoFocus={autoFocus}
        onKeyDown={event => {
          const shortcut = (event.metaKey || event.ctrlKey) && !event.altKey;
          const key = event.key.toLowerCase();
          if (shortcut && (key === 'z' || key === 'y')) {
            const redo = key === 'y' || event.shiftKey;
            event.preventDefault();
            const move = redo ? redoComposer(undoRef.current, value) : undoComposer(undoRef.current, value);
            if (!move) return;
            undoRef.current = move.state;
            leaveHistory();
            applyProgrammatic(move.value);
            return;
          }
          if (slashOpen) {
            if (event.key === 'ArrowDown' && visibleSlashEntries.length) {
              event.preventDefault();
              setSlashIndex(index => {
                for (let step = 1; step <= visibleSlashEntries.length; step += 1) {
                  const next = (index + step) % visibleSlashEntries.length;
                  if (!visibleSlashEntries[next]?.disabled) return next;
                }
                return index;
              });
              return;
            }
            if (event.key === 'ArrowUp' && visibleSlashEntries.length) {
              event.preventDefault();
              setSlashIndex(index => {
                for (let step = 1; step <= visibleSlashEntries.length; step += 1) {
                  const next = (index - step + visibleSlashEntries.length) % visibleSlashEntries.length;
                  if (!visibleSlashEntries[next]?.disabled) return next;
                }
                return index;
              });
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              const entry = visibleSlashEntries[slashIndex] ?? visibleSlashEntries.find(item => !item.disabled);
              if (entry) void chooseSlash(entry);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setSlashOpen(false);
              setSlashScope('root');
              return;
            }
          }
          if (mentionOpen && activeMention) {
            if (event.key === 'ArrowDown' && mentionEntries.length) {
              event.preventDefault();
              setMentionIndex(index => (index + 1) % mentionEntries.length);
              return;
            }
            if (event.key === 'ArrowUp' && mentionEntries.length) {
              event.preventDefault();
              setMentionIndex(index => (index - 1 + mentionEntries.length) % mentionEntries.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              if (mentionEntries.length) chooseMention(mentionEntries[mentionIndex] ?? mentionEntries[0]!);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setMentionOpen(false);
              return;
            }
          }
          // Prompt history: only while neither the / nor @ menu is open, and
          // only when the caret is on the edge line so multiline edits still work.
          if (!slashOpen && !mentionOpen && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            const input = event.currentTarget;
            const collapsed = input.selectionStart === input.selectionEnd;
            const caret = input.selectionStart ?? value.length;
            const browsing = historyRef.current.cursor !== null;
            if (event.key === 'ArrowUp') {
              if (browsing || (collapsed && !value.slice(0, caret).includes('\n'))) {
                const move = composerHistoryUp(historyState(), value);
                if (move) {
                  event.preventDefault();
                  historyRef.current = move.state;
                  setHistoryBrowsing(move.state.cursor !== null);
                  applyProgrammatic(move.value);
                  return;
                }
              }
              return;
            }
            if (browsing || (collapsed && !value.slice(caret).includes('\n'))) {
              const move = composerHistoryDown(historyState());
              if (move) {
                event.preventDefault();
                historyRef.current = move.state;
                setHistoryBrowsing(move.state.cursor !== null);
                applyProgrammatic(move.value);
                return;
              }
            }
            return;
          }
          if (event.key === 'Tab' && showingSuggestion) {
            event.preventDefault();
            rememberEdit(value, availableSuggestion);
            leaveHistory();
            onChange(availableSuggestion);
            setCursor(availableSuggestion.length);
            requestAnimationFrame(() => {
              const input = textareaRef.current;
              input?.focus();
              input?.setSelectionRange(availableSuggestion.length, availableSuggestion.length);
            });
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!sendDisabled) {
              setAttachmentNotices([]);
              rememberPrompt();
              (onSubmit ?? onSend)();
            }
          }
        }}
      />
      <div className="chat-composer-controls">
        <button type="button" className="icon-button composer-attach" data-testid={attachTestId} onClick={() => attachmentInputRef.current?.click()} aria-label="选择附件" title="选择附件">
          <Icon name="plus" size={17} />
        </button>
        <input
          ref={attachmentInputRef}
          className="visually-hidden"
          data-testid={attachmentInputTestId}
          type="file"
          multiple
          onChange={event => {
            void addAttachments(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = '';
          }}
        />
        <FullAccessToggle />
        {leftActions}
        <div className="composer-spacer" />
        <button
          type="button"
          className="icon-button primary"
          data-testid={sendTestId}
          data-mode={primaryMode}
          disabled={sendDisabled}
          onClick={() => {
            if (!sendDisabled) {
              setAttachmentNotices([]);
              if (primaryMode === 'send') rememberPrompt();
            }
            onSend();
          }}
          aria-label={primaryLabel}
          title={primaryLabel}
        >
          <Icon name={primaryMode === 'pause' ? 'pause' : primaryMode === 'resume' ? 'play' : primaryMode === 'pending' ? 'refresh' : 'send'} size={17} />
        </button>
      </div>
    </div>
  );
}
