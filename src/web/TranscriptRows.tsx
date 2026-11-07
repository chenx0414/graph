import { toolActivity } from './tool-activity.ts';
import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { OrbState } from 'thinking-orbs';
import {
  messageAttachments,
  type ConversationMessage,
} from '../core/conversation-projection.ts';
import { attachmentImageSource } from './attachments.ts';
import { copyText, writeClipboardText } from './chat-copy.ts';
import { Markdown } from './Markdown.tsx';
import { RsiCard } from './RsiCard.tsx';
import { CompactionNotice } from './CompactionNotice.tsx';
import { mendStreamingMarkdown, splitMarkdownBlocks, type MarkdownVeil } from './markdown-blocks.ts';
import { toolSettledRowOf, transcriptFoldPolicy, type TranscriptRow } from './transcript-model.ts';
import { ToolActivityRow } from './ToolActivityRow.tsx';
import { clockLabel, elapsedLabel } from './labels.ts';
import { Icon, toast } from './ui.tsx';
import { usePacedStreamText } from './use-paced-stream.ts';
import { useStreamVeils } from './use-stream-veils.ts';

const ThinkingOrb = lazy(async () => {
  const library = await import('thinking-orbs');
  return { default: library.ThinkingOrb };
});

function ActivityOrb({ state }: { state: OrbState }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 2_000);
    return () => window.clearTimeout(timer);
  }, []);
  return visible ? <Suspense fallback={null}>
    <ThinkingOrb state={state} size={20} theme="light" aria-hidden="true" />
  </Suspense> : null;
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="message-copy"
      data-testid="message-copy"
      title="复制这条消息"
      aria-label="复制这条消息"
      onClick={() => void writeClipboardText(text, navigator.clipboard, toast)}
    >
      <Icon name="copy" size={14} />
    </button>
  );
}

function MessageMeta({ createdAt, elapsedMs }: { createdAt?: number | undefined; elapsedMs?: number | null | undefined }) {
  if (!createdAt) return null;
  return (
    <span className="message-meta">
      <span data-testid="message-time" title={new Date(createdAt).toLocaleString()}>{clockLabel(createdAt)}</span>
      {elapsedMs ? <span data-testid="message-elapsed">{`· ${elapsedLabel(elapsedMs)}`}</span> : null}
    </span>
  );
}

function MessageRow({ message, userAuthor, copyable = '', markdown = true }: { message: ConversationMessage; userAuthor?: string; copyable?: string; markdown?: boolean }) {
  const command = message.data && typeof (message.data as Record<string, unknown>).command === 'string'
    ? String((message.data as Record<string, unknown>).command)
    : undefined;
  if (message.role === 'user' && command) {
    return (
      <div className="message-row" data-role="system-action" data-command={command} data-state={message.state} data-testid="message-command">
        <Icon name="refresh" size={12} />
        <span>{command === 'compact' ? '已压缩上下文' : command}</span>
        {message.state === 'pending' && <span className="message-state">执行中</span>}
        <MessageMeta createdAt={message.createdAt} />
      </div>
    );
  }
  if (message.role === 'user') {
    const attachments = messageAttachments(message);
    const peerFrom = message.data && (message.data as Record<string, unknown>).peer === true && typeof (message.data as Record<string, unknown>).from === 'string'
      ? (message.data as Record<string, unknown>).from as string
      : undefined;
    return (
      <div className="message-row" data-role="user" data-testid="message-user" data-state={message.state}>
        <div className="message-stack">
          <div className="message-author">
            {peerFrom ? `${peerFrom} · Agent 消息` : userAuthor ?? (message.kind === 'briefing' ? '任务说明' : '我')}
            {message.state === 'pending' && <span className="message-state"> · 等待处理</span>}
          </div>
          <div className="message-content">
            {message.text && (markdown ? <Markdown text={message.text} /> : <p>{message.text}</p>)}
            {attachments.length > 0 && (
              <div className="message-attachments">
                {attachments.map(attachment => (
                  <span key={`${attachment.name}:${attachment.size}`} title={`${attachment.type} · ${attachment.size} bytes`}>
                    {attachmentImageSource(attachment)
                      ? <img className="message-attachment-image" src={attachmentImageSource(attachment)} alt={attachment.name} />
                      : <Icon name="paperclip" size={12} />}
                    {attachment.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          {copyable && (
            <div className="message-actions"><CopyButton text={copyable} /><MessageMeta createdAt={message.createdAt} /></div>
          )}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    return (
      <div className="message-row answer-row" data-role="assistant" data-answer="true" data-testid="message-assistant">
        <div className="message-stack">
          <div className="message-author">主 Agent · 最终回答</div>
          <div className="message-content answer-card">
            {markdown ? <Markdown text={message.text} /> : <p className="message-plain">{message.text}</p>}
          </div>
        </div>
      </div>
    );
  }
  if (message.role === 'tool') {
    return <div className="message-row" data-role="tool" data-testid="message-tool"><div className="message-stack"><div className="message-content">工具 · {message.text}</div></div></div>;
  }
  return <div className="message-row" data-role="system" data-testid="message-system"><div className="message-stack"><div className="message-content">{message.text}</div></div></div>;
}

function ToolActivityGroup({ row }: { row: Extract<TranscriptRow, { kind: 'tools' }> }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? transcriptFoldPolicy.toolGroupExpanded;
  const activeTool = [...row.tools].reverse().find(tool => !tool.done);
  const kind = activeTool ? toolActivity(activeTool.name, activeTool.summary).kind : 'other';
  const orbState: OrbState = kind === 'search' || kind === 'browse' ? 'searching'
    : kind === 'run' ? 'solving'
      : kind === 'edit' ? 'composing' : 'working';
  return (
    <section
      className="tool-activity-group"
      data-testid="tool-activity-group"
      data-tool-calls={row.tools.map(tool => tool.id).join(' ')}
      data-active={row.active} data-background={row.background}
      data-open={open}
      data-error={row.tools.some(tool => tool.error)}
    >
      <button
        type="button"
        className="tool-group-toggle"
        onClick={() => setManualOpen(current => !(current ?? false))}
        aria-expanded={open}
        aria-label={open ? '收起工具活动' : '展开工具活动'}
      >
        <span className="tool-group-indicator" aria-hidden="true">
          {row.active ? <ActivityOrb key={activeTool?.id ?? row.id} state={orbState} /> : <Icon name={row.tools.some(tool => tool.error) ? 'alert' : 'check'} size={13} />}
        </span>
        <span className="tool-group-copy">
          <strong>{row.summary}</strong>
          <span data-testid="tool-group-state">{row.active ? (row.background ? '后台执行中' : '进行中') : `${row.tools.length} 项活动`}</span>
        </span>
        <Icon name="chevron" size={14} className="tool-group-chevron" />
      </button>
      {row.tools.some(tool => tool.attachments?.length) && <div className="tool-group-images" data-testid="tool-read-images">
        {row.tools.flatMap(tool => tool.attachments ?? []).map((attachment, index) => {
          const source = attachmentImageSource(attachment);
          return source ? <a href={source} target="_blank" rel="noreferrer" key={`${attachment.name}-${index}`}>
            <img className="message-attachment-image" src={source} alt={attachment.name} loading="lazy" />
          </a> : null;
        })}
      </div>}
      {row.tools.some(tool => tool.reason) && <ul className="tool-activity-reasons" data-testid="tool-error-reasons">
        {row.tools.filter(tool => tool.reason).map(tool => (
          <li key={`reason:${tool.id}`} data-testid="tool-error-reason">{tool.reason}</li>
        ))}
      </ul>}
      <div className="tool-group-content" aria-hidden={!open}>
        <div className="tool-group-content-inner">
          <ol className="tool-activity-list">
            {row.tools.map(tool => <ToolActivityRow key={tool.id} tool={tool} />)}
          </ol>
        </div>
      </div>
    </section>
  );
}

function NarrationRow({ row }: { row: Extract<TranscriptRow, { kind: 'narration' }> }) {
  return (
    <div className="message-row narration-row" data-role="assistant" data-testid="message-narration">
      <div className="message-stack">
        <div className="message-author"><Icon name="spark" size={12} />思考与过程</div>
        <div className="message-content answer-card"><Markdown text={row.text} /></div>
      </div>
    </div>
  );
}

function CollapsedTurn({ row, markdown = true }: { row: Extract<TranscriptRow, { kind: 'activity' }>; markdown?: boolean }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? (transcriptFoldPolicy.turnExpanded || !row.collapsed);
  return (
    <div className="collapsed-turn" data-testid="collapsed-turn" data-open={open}>
      <button
        type="button"
        className="collapsed-turn-toggle"
        onClick={() => setManualOpen(current => !(current ?? !row.collapsed))}
        aria-expanded={open}
        aria-label={open ? '收起这一轮的思考与工具调用' : '展开这一轮的思考与工具调用'}
      >
        <span>{`上方 ${row.items.length} 步思考与工具调用`}</span>
        <Icon name="chevron" size={13} className="collapsed-turn-chevron" />
      </button>
      {open && (
        <div className="collapsed-turn-body">
          {row.rows.map(child => <TranscriptRowView key={child.id} row={child} markdown={markdown} />)}
        </div>
      )}
    </div>
  );
}

function sameVeils(left: MarkdownVeil[], right: MarkdownVeil[]) {
  return left.length === right.length && left.every((veil, index) => {
    const other = right[index]!;
    return veil.start === other.start && veil.end === other.end && veil.opacity === other.opacity;
  });
}

const AssistantMarkdownBlock = memo(function AssistantMarkdownBlock(input: {
  source: string;
  veils: MarkdownVeil[];
}) {
  return <Markdown text={input.source} veils={input.veils} />;
}, (previous, next) => previous.source === next.source && sameVeils(previous.veils, next.veils));

function PlainText({ text, veils }: { text: string; veils: MarkdownVeil[] }) {
  if (!veils.length) return <>{text}</>;
  const cuts = new Set<number>([0, text.length]);
  for (const veil of veils) {
    if (veil.start > 0 && veil.start < text.length) cuts.add(veil.start);
    if (veil.end > 0 && veil.end < text.length) cuts.add(veil.end);
  }
  const ordered = [...cuts].sort((left, right) => left - right);
  const nodes: ReactNode[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!;
    const end = ordered[index + 1]!;
    if (start === end) continue;
    const segment = text.slice(start, end);
    const veil = veils.find(item => item.start <= start && end <= item.end);
    nodes.push(veil && veil.opacity < 1
      ? <span className="stream-veil" key={`${start}-${end}`} style={{ opacity: veil.opacity }}>{segment}</span>
      : <span key={`${start}-${end}`}>{segment}</span>);
  }
  return <>{nodes}</>;
}

function AssistantResponse({ row, author, copyable = '', markdown = true }: {
  row: Extract<TranscriptRow, { kind: 'assistant' }>;
  author?: string;
  copyable?: string;
  markdown?: boolean;
}) {
  const paced = usePacedStreamText(row.text, row.operationId, row.streaming, row.attached);
  const visualStreaming = row.streaming || paced.revealing;
  const veils = useStreamVeils(paced.text, row.operationId, visualStreaming);
  const blocks = splitMarkdownBlocks(paced.text);
  const authorLabel = visualStreaming
    ? '思考与过程 · 生成中'
    : author ?? (row.narration ? '思考与过程' : '主 Agent · 最终回答');
  const testId = row.narration
    ? (visualStreaming ? 'streaming' : 'message-narration')
    : (visualStreaming ? 'streaming' : 'message-assistant');
  return (
    <div
      className={`message-row ${visualStreaming ? 'process-row' : 'answer-row'}`}
      data-role="assistant"
      data-answer={!visualStreaming}
      data-process={visualStreaming}
      data-reveal-length={paced.length}
      data-reveal-target={paced.targetLength}
      data-testid={testId}
    >
      <div className="message-stack">
        <div className={`message-author ${visualStreaming ? 'process-author' : ''}`}>
          {visualStreaming && <Icon name="spark" size={12} />}
          {authorLabel}
        </div>
        <div className={`message-content ${visualStreaming ? 'streaming-card' : 'answer-card'}`}>
          {markdown ? (
            <div className="streaming-markdown">
              {blocks.map((block, index) => {
                const tail = visualStreaming && index === blocks.length - 1;
                const source = tail ? mendStreamingMarkdown(block.source) : block.source;
                const localVeils = veils.flatMap(veil => {
                  const start = Math.max(block.start, veil.start);
                  const end = Math.min(block.end, veil.end);
                  return start < end
                    ? [{ start: start - block.start, end: end - block.start, opacity: veil.opacity }]
                    : [];
                });
                return (
                  <AssistantMarkdownBlock
                    key={`${row.id}.${block.index}`}
                    source={source}
                    veils={localVeils}
                  />
                );
              })}
            </div>
          ) : (
            <div className="streaming-markdown message-plain" data-plain="true" data-testid="message-plain">
              <PlainText text={paced.text} veils={veils} />
            </div>
          )}
          {visualStreaming && <span className="streaming-caret" aria-hidden="true" />}
        </div>
        {copyable && (
          <div className="message-actions"><CopyButton text={copyable} /><MessageMeta createdAt={row.createdAt} elapsedMs={row.elapsedMs} /></div>
        )}
      </div>
    </div>
  );
}

function ThinkingStatus() {  return (
    <div className="message-row agent-status-row" data-role="assistant" data-testid="agent-thinking">
      <div className="agent-working" role="status">
        <span className="agent-thinking-orb" aria-hidden="true">
          <ActivityOrb state="breathing" />
        </span>
        正在思考…
      </div>
    </div>
  );
}

export function TranscriptRowView({ row, assistantAuthor, userAuthor, markdown = true }: {
  row: TranscriptRow;
  assistantAuthor?: string;
  userAuthor?: string;
  markdown?: boolean;
}) {
  if (row.kind === 'message') {
    const settled = toolSettledRowOf(row.message);
    if (settled) return <ToolSettledCard row={settled} />;
    return userAuthor
      ? <MessageRow message={row.message} userAuthor={userAuthor} copyable={copyText(row)} markdown={markdown} />
      : <MessageRow message={row.message} copyable={copyText(row)} markdown={markdown} />;
  }
  if (row.kind === 'assistant') {
    return assistantAuthor
      ? <AssistantResponse row={row} author={assistantAuthor} copyable={copyText(row)} markdown={markdown} />
      : <AssistantResponse row={row} copyable={copyText(row)} markdown={markdown} />;
  }
  if (row.kind === 'tools') return <ToolActivityGroup row={row} />;
  if (row.kind === 'narration') return <NarrationRow row={row} />;
  if (row.kind === 'activity') return <CollapsedTurn row={row} markdown={markdown} />;
  if (row.kind === 'rsi') return <RsiCard row={row} />;
  if (row.kind === 'rsiFull') return <RsiFullCard row={row} />;
  if (row.kind === 'toolSettled') return <ToolSettledCard row={row} />;
  if (row.kind === 'compaction') return <CompactionNotice row={row} />;
  if (row.kind === 'thinking') {
    return <ThinkingStatus />;
  }
  return null;
}

function ToolSettledCard({ row }: { row: Extract<TranscriptRow, { kind: 'toolSettled' }> }) {
  const failed = row.state !== '' && row.state !== 'settled';
  return (
    <div className="compaction-notice" data-testid="tool-settled-notice" data-role="system" data-delivered={row.delivered ? 'steer' : 'turn'}>
      <div className="compaction-notice-head" title={row.text}>
        <span className="compaction-notice-rule" aria-hidden="true" />
        <span className="compaction-notice-text">
          <Icon name={failed ? 'alert' : 'tool'} size={13} />
          {row.tool} {failed ? '已结束 · ' + row.state : '已完成'}
          {row.delivered ? ' · 已插入当前回合' : ' · 结果已回到会话'}
        </span>
        <span className="compaction-notice-rule" aria-hidden="true" />
      </div>
    </div>
  );
}

function RsiFullCard({ row }: { row: Extract<TranscriptRow, { kind: 'rsiFull' }> }) {
  const failed = row.files.length;
  return (
    <div className="compaction-notice" data-testid="rsi-full-notice" data-role="system" data-verdict={row.environment ? 'environment' : 'regression'}>
      <div className="compaction-notice-head" title={row.text}>
        <span className="compaction-notice-rule" aria-hidden="true" />
        <span className="compaction-notice-text">
          <Icon name="archive" size={13} />
          后台全量确认 · {row.verdict || '失败'}
        </span>
        <span className="compaction-notice-rule" aria-hidden="true" />
      </div>
      {row.verdictDetails.length > 0 && (
        <ul className="compaction-notice-details" data-testid="rsi-full-details">
          {row.verdictDetails.map(detail => <li key={detail}>{detail}</li>)}
        </ul>
      )}
      <div className="compaction-summary" data-testid="rsi-full-summary">
        {failed > 0 ? `${failed} 个文件失败` : '没有解析出失败文件'}
        {row.commit ? ` · 提交 ${row.commit.slice(0, 8)}` : ''}
      </div>
      {failed > 0 && (
        <ul className="compaction-summary" data-testid="rsi-full-files">
          {row.files.map(file => <li key={file}><code>{file}</code></li>)}
        </ul>
      )}
      {row.logPath && (
        <div className="compaction-summary">
          <code>{row.logPath}</code>
        </div>
      )}
    </div>
  );
}
