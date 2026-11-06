import { useMemo } from 'react';
import { Button, toast } from './ui.tsx';

/**
 * The prompt one real send carried, rendered wherever it is shown.
 *
 * The master's turn and a subagent's round are read from the same ledger columns, so the
 * panel is shared instead of copied: the node view cannot quietly diverge from the master
 * view about what "the prompt really sent" looks like. Everything here is read out of the
 * record; nothing is recomposed from settings at render time.
 */
export function RecordedPromptPanel(input: {
  testId: string; text: string | null; tools: string | null; emptyText: string;
  /** Which half to render. The console gives each half its own tab; the node view shows both. */
  part?: 'both' | 'prompt' | 'tools';
}) {
  const { testId, text, tools, emptyText, part = 'both' } = input;
  const declarationCount = useMemo(() => {
    if (!tools) return 0;
    try {
      const parsed = JSON.parse(tools) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch { return 0; }
  }, [tools]);
  // The recorded payload is the SDK's declarations; pretty-print only for reading.
  const declarationText = useMemo(() => {
    if (!tools) return '';
    try { return JSON.stringify(JSON.parse(tools), null, 2); } catch { return tools; }
  }, [tools]);

  async function copy(value: string | null, done: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast(done, 'success');
    } catch (reason) {
      toast(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
    }
  }

  return (
    <>
      {part !== 'tools' && <div className="agent-preview-meta">
        <strong>实际发出（最近一次模型请求）</strong>
        <span>{text ? `${text.length.toLocaleString()} 字符` : emptyText}</span>
        <Button size="sm" icon="file" disabled={!text} onClick={() => void copy(text, 'system prompt 已复制')}>复制 Prompt</Button>
      </div>}
      {part !== 'tools' && (text
        ? <pre className="agent-preview-markdown" data-testid={`${testId}-text`}>{text}</pre>
        : <p className="agent-preview-notice" data-testid={`${testId}-empty`}>{emptyText}</p>)}
      {part !== 'prompt' && tools ? (
        <div className="agent-preview-panel" data-testid={`${testId}-tools`}>
          <div className="agent-preview-meta">
            <strong>tool calling（最近一次模型请求）</strong>
            <span>{`${declarationCount.toLocaleString()} 个工具 · ${tools.length.toLocaleString()} 字符`}</span>
            <Button size="sm" icon="file" onClick={() => void copy(tools, 'tool calling 已复制')}>复制声明</Button>
          </div>
          <pre className="agent-preview-markdown" data-testid={`${testId}-tools-text`}>{declarationText}</pre>
        </div>
      ) : null}
    </>
  );
}
