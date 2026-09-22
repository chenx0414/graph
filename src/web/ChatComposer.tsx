import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { insertAtCaret, readClipboardText } from './chat-paste.ts';
import { FullAccessToggle } from './FullAccessToggle.tsx';
import type { AgentCapabilityView, AgentToolView } from './AgentContext.tsx';
import type { ComposerModel, ComposerTelemetryView, ThinkingLevel } from './ComposerTelemetry.tsx';
import {
  filterSlashEntries,
  slashTargetToken,
  slashEntries,
  SlashMenu,
  type SlashEntry,
  type SlashScope,
} from './SlashCommands.tsx';
import { Icon, toast } from './ui.tsx';

export type ChatAttachment = { name: string; type: string; size: number; text: string };
type MentionEntry = { path: string; kind: 'file' | 'directory' };
type Mention = { start: number; end: number; query: string };
type Slash = { start: number; end: number; query: string };

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'sh', 'zsh', 'fish', 'sql', 'graphql',
]);

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

function isTextAttachment(file: File) {
  if (file.type.startsWith('text/') || ['application/json', 'application/xml', 'image/svg+xml'].includes(file.type)) return true;
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  return TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

function attachmentSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 102_400 ? 1 : 0)} KB`;
}

export function ChatComposer({
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  projectId,
  placeholder,
  onSend,
  sendDisabled,
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
  sendDisabled: boolean;
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
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
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
    const next = [...attachments];
    let rejected = 0;
    for (const file of files) {
      if (next.length >= 5) { rejected += 1; continue; }
      if (!isTextAttachment(file) || file.size > 262_144) { rejected += 1; continue; }
      try {
        const body = await file.text();
        if (body.includes('\0')) { rejected += 1; continue; }
        if (!next.some(item => item.name === file.name && item.size === file.size)) {
          next.push({ name: file.name, type: file.type || 'text/plain', size: file.size, text: body });
        }
      } catch {
        rejected += 1;
      }
    }
    onAttachmentsChange(next);
    if (rejected) toast(`已忽略 ${rejected} 个不支持的附件；仅支持 256 KiB 以内的文本文件`, 'info');
  }

  async function pasteClipboardAtCaret(input: HTMLTextAreaElement | null) {
    const currentValue = input?.value ?? value;
    const start = input?.selectionStart ?? cursor;
    const end = input?.selectionEnd ?? cursor;
    const text = await readClipboardText(
      typeof navigator !== 'undefined' && navigator.clipboard
        ? () => navigator.clipboard.readText()
        : undefined,
    );
    // Empty, non-text or denied clipboard: stay silent and keep the input as-is.
    if (!text) {
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const next = insertAtCaret({ value: currentValue, start, end, text });
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
        await onSlashModelSelect?.(entry.action.model, entry.action.model.reasoning === false ? 'off' : currentLevel);
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
    <div className={`chat-composer ${className}`} ref={composerRef}>
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
            <span className="composer-attachment" key={`${attachment.name}:${attachment.size}`}>
              <Icon name="paperclip" size={12} />
              <span className="truncate">{attachment.name}</span>
              <span className="faint">{attachmentSize(attachment.size)}</span>
              <button type="button" onClick={() => onAttachmentsChange(attachments.filter(item => item !== attachment))} aria-label={`移除附件 ${attachment.name}`}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid={inputTestId}
        value={value}
        onChange={event => {
          const next = event.target.value;
          const position = event.target.selectionStart ?? next.length;
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
        onContextMenu={event => {
          // Paste the clipboard at the caret instead of opening any menu.
          event.preventDefault();
          void pasteClipboardAtCaret(event.currentTarget);
        }}
        placeholder={showingSuggestion ? availableSuggestion : placeholder}
        data-suggestion={showingSuggestion ? availableSuggestion : undefined}
        autoFocus={autoFocus}
        onKeyDown={event => {
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
          if (event.key === 'Tab' && showingSuggestion) {
            event.preventDefault();
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
            if (!sendDisabled) onSend();
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
        <button type="button" className="icon-button primary" data-testid={sendTestId} disabled={sendDisabled} onClick={onSend} aria-label="发送消息">
          <Icon name="send" size={17} />
        </button>
      </div>
    </div>
  );
}
