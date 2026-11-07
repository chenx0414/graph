import { useMemo } from 'react';
import { Button, toast } from './ui.tsx';

export function RecordedPromptPanel(input: {
  testId: string; text: string | null; tools: string | null; emptyText: string;
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
