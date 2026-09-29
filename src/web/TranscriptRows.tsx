import { toolActivity } from './tool-activity.ts';
import { memo, useState, type ReactNode } from 'react';
import {
  messageAttachments,
  type ConversationMessage,
} from '../core/conversation-projection.ts';
import { attachmentImageSource } from './attachments.ts';
import { copyText, writeClipboardText } from './chat-copy.ts';
import { Markdown } from './Markdown.tsx';
import { mendStreamingMarkdown, splitMarkdownBlocks, type MarkdownVeil } from './markdown-blocks.ts';
import {
  activeToolStatus,
  toolGroupSummary,
  type TranscriptRow,
} from './transcript-model.ts';
import { clockLabel, elapsedLabel } from './labels.ts';
import { Icon, toast } from './ui.tsx';
import { usePacedStreamText } from './use-paced-stream.ts';
import { useStreamVeils } from './use-stream-veils.ts';

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
  if (message.role === 'user') {
    const attachments = messageAttachments(message);
    // A peer Agent's message arrived like a prompt; label it with its sender rather than "我" so the
    // reader never mistakes another Agent's words for the human's.
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

function toolIcon(name: string): 'file' | 'folder' | 'search' | 'bolt' | 'refresh' {
  if (name === 'list_dir') return 'folder';
  if (name === 'search' || name === 'glob' || name === 'web_search') return 'search';
  if (name === 'run_command') return 'bolt';
  if (['write_file', 'apply_patch', 'edit'].includes(name)) return 'file';
  if (name === 'fetch') return 'refresh';
  return 'file';
}

function ToolActivityGroup({ row }: { row: Extract<TranscriptRow, { kind: 'tools' }> }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  // Tool calls stay folded away by default, running or finished; the button opens
  // one group when its detail is needed.
  const open = manualOpen ?? false;
  const summary = row.active ? activeToolStatus(row.tools) : toolGroupSummary(row.tools);
  return (
    <section
      className="tool-activity-group"
      data-testid="tool-activity-group"
      data-active={row.active}
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
          {row.active ? <span className="working-pulse" /> : <Icon name={row.tools.some(tool => tool.error) ? 'alert' : 'check'} size={13} />}
        </span>
        <span className="tool-group-copy">
          <strong>{summary}</strong>
          <span>{row.active ? '进行中' : `${row.tools.length} 项活动`}</span>
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
      <div className="tool-group-content" aria-hidden={!open}>
        <div className="tool-group-content-inner">
          <ol className="tool-activity-list">
            {row.tools.map(tool => (
              <li key={tool.id} data-error={tool.error} data-done={tool.done}>
                <span className="tool-activity-icon"><Icon name={toolIcon(tool.name)} size={14} /></span>
                <span className="tool-activity-label">{toolActivity(tool.name, tool.summary).label} <span className="tool-name">{toolActivity(tool.name, tool.summary).name}</span></span>
                <span className="tool-activity-summary" title={tool.summary}>{tool.summary}</span>
                <span className="tool-activity-state">{tool.error ? '失败' : tool.done ? '完成' : '进行中'}</span>
              </li>
            ))}
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

/**
 * One finished turn's thinking and tool calls, folded behind a single muted line
 * above the final answer. Opening it brings back the same rows the turn showed
 * while it was running: narration bubbles with the tool groups interleaved.
 */
function CollapsedTurn({ row, markdown = true }: { row: Extract<TranscriptRow, { kind: 'activity' }>; markdown?: boolean }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? (!row.collapsed || row.rows.some(child => child.kind === 'tools' && child.tools.some(tool => tool.attachments?.length)));
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

function RsiReport({ row }: { row: Extract<TranscriptRow, { kind: 'rsi' }> }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const { rsi } = row;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? false;
  const statusLabel = rsi.status === 'applied' ? (rsi.activation === 'active' ? '已生效' : rsi.activation === 'pending_reload' ? '等待重载' : '已提交')
    : rsi.status === 'checks_failed' ? '检查未通过'
      : rsi.status === 'rolled_back' ? '已回滚' : '不可用';
  const files = rsi.files.length ? rsi.files : rsi.pendingFiles;
  return (
    <section className="rsi-report" data-testid="rsi-report" data-status={rsi.status}>
      <header className="rsi-report-header">
        <span className="rsi-report-icon" aria-hidden="true"><Icon name="spark" size={14} /></span>
        <div className="rsi-report-heading">
          <strong>{rsi.title}</strong>
          <span className="rsi-report-badge">{statusLabel}</span>
        </div>
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setExpanded(!open)}>{open ? '收起' : '展开'}</button>
      </header>
      {open && <>
      {rsi.problem && <p className="rsi-report-problem">{rsi.problem}</p>}
      {(rsi.branch || rsi.commit) && (
        <dl className="rsi-report-meta">
          {rsi.branch && <div><dt>分支</dt><dd>{rsi.branch}</dd></div>}
          {rsi.commit && <div><dt>提交</dt><dd>{rsi.commit.slice(0, 12)}</dd></div>}
        </dl>
      )}
      {files.length > 0 && (
        <div className="rsi-report-files">
          {files.map(file => <code key={file}>{file}</code>)}
        </div>
      )}
      {rsi.validation.length > 0 && (
        <ul className="rsi-report-checks">
          {rsi.validation.map(item => (
            <li key={item.command} data-status={item.status}>
              <Icon name={item.status === 'passed' ? 'check' : 'alert'} size={12} />
              <span className="rsi-report-check-command">{item.command}</span>
              <span className="rsi-report-check-state">{item.status === 'passed' ? '通过' : '失败'}</span>
            </li>
          ))}
        </ul>
      )}
      {rsi.error && <p className="rsi-report-error">{rsi.error}</p>}
      {rsi.status === 'checks_failed' && (
        <p className="rsi-report-pending">改动已保留在工作区、尚未提交，也不会触发重载。继续修复后再次调用即可。</p>
      )}
      {rsi.restartRequired && (
        <p className="rsi-report-restart">
          <Icon name="refresh" size={12} />
          {rsi.activation === 'active' ? '宿主已确认重载，改动已生效。'
            : rsi.force
              ? '已提交，等待强制重载确认；可能中断正在执行的任务。'
              : '已提交，等待正在执行的任务结束后重载。'}
        </p>
      )}
      {rsi.diff && (
        <>
          <button
            type="button"
            className="rsi-report-diff-toggle"
            onClick={() => setDiffOpen(current => !current)}
            aria-expanded={diffOpen}
          >
            <span className="rsi-report-diff-chevron" data-open={diffOpen} aria-hidden="true"><Icon name="chevron" size={12} /></span>
            {diffOpen ? '收起改动' : '查看改动'}
          </button>
          {diffOpen && <pre className="rsi-report-diff">{rsi.diff}</pre>}
        </>
      )}
      </>}
    </section>
  );
}

const AssistantMarkdownBlock = memo(function AssistantMarkdownBlock(input: {
  source: string;
  veils: MarkdownVeil[];
}) {
  return <Markdown text={input.source} veils={input.veils} />;
}, (previous, next) => previous.source === next.source && sameVeils(previous.veils, next.veils));

/**
 * Plain-text rendering that keeps the streaming veil fade without running the
 * Markdown parser; used when the "Markdown 渲染" preference is off.
 */
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
  // Pacing and veils are keyed by the operation, not by the row id: the live row
  // and the durable reply row are two rows of the same turn, and the reveal has
  // to survive that handoff.
  const paced = usePacedStreamText(row.text, row.operationId, row.streaming, row.attached);
  const visualStreaming = row.streaming || paced.revealing;
  const veils = useStreamVeils(paced.text, row.operationId, visualStreaming);
  const blocks = splitMarkdownBlocks(paced.text);
  // A completed narration is a normal bubble; only the part still growing keeps
  // the "生成中" label and the caret.
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

export function TranscriptRowView({ row, assistantAuthor, userAuthor, markdown = true }: {
  row: TranscriptRow;
  assistantAuthor?: string;
  userAuthor?: string;
  markdown?: boolean;
}) {
  if (row.kind === 'message') {
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
  if (row.kind === 'rsi') return <RsiReport row={row} />;
  if (row.kind === 'thinking') {
    return (
      <div className="message-row agent-status-row" data-role="assistant" data-testid="agent-thinking">
        <div className="agent-working">
          <span className="working-pulse" aria-hidden="true" />
          正在思考…
        </div>
      </div>
    );
  }
  return null;
}
