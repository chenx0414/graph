import { useState } from 'react';
import { api } from './api.ts';
import { describeQuestion } from './labels.ts';
import { Button, Pill, toast } from './ui.tsx';

function questionPrompt(kind: string, data: Record<string, unknown>) {
  const text = (key: string) => typeof data[key] === 'string' && String(data[key]).trim() ? String(data[key]).trim() : undefined;
  if (kind === 'permission') {
    const grant = text('grant');
    return grant ? `执行需要你授权：${grant}` : '执行需要你确认一项外部权限。';
  }
  if (kind === 'budget' || kind === 'reservation_exceeded') return '该 Agent 已达到当前额度边界，需要你决定是否追加预算。';
  if (kind === 'human_check') return text('prompt') ?? '需要你完成一项人工验收。';
  return text('prompt') ?? text('reason') ?? text('message') ?? '这项操作需要你确认。';
}

/** One open question answered through the authenticated task command path. */
export function QuestionReply({ taskId, question, onDone }: {
  taskId: string;
  question: { id: string; kind: string; data: { prompt?: string; grant?: string; reason?: string; output?: unknown } & Record<string, unknown> };
  onDone: () => void;
}) {
  const [tokens, setTokens] = useState('100000');
  const [inputTokens, setInputTokens] = useState('0');
  const [outputTokens, setOutputTokens] = useState('0');
  const [value, setValue] = useState('');
  const [proof, setProof] = useState('');
  const [usageMode, setUsageMode] = useState<'usage' | 'reconcile'>('usage');
  const [error, setError] = useState('');
  async function submit(answer: unknown) {
    try {
      await api(`/api/tasks/${taskId}/answer`, { method: 'POST', body: JSON.stringify({ questionId: question.id, answer, requestId: `ans-${question.id}-${crypto.randomUUID()}` }) });
      toast('已提交答复', 'success');
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast(`答复失败：${message}`, 'danger');
    }
  }
  return (
    <li className="list-item" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
      <div className="row">
        <Pill tone="warn">{describeQuestion(question.kind)}</Pill>
        <code className="faint">{question.kind}</code>
        <span>{questionPrompt(question.kind, question.data)}</span>
      </div>
      <details style={{ maxWidth: '100%', margin: '4px 0' }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>查看技术详情</summary>
        <pre data-testid={`question-data-${question.id}`} style={{ maxWidth: '100%', margin: '4px 0', fontSize: 12 }}>{JSON.stringify(question.data, null, 2)}</pre>
      </details>
      <div className="row">
        {question.kind === 'budget' && <input className="input" style={{ width: 130 }} data-testid="budget-tokens" type="number" min={1} value={tokens} onChange={event => setTokens(event.target.value)} />}
        {question.kind === 'waiting' && <input className="input" style={{ width: 220 }} data-testid="waiting-value" value={value} onChange={event => setValue(event.target.value)} placeholder="外部条件已满足的说明" />}
        {question.kind === 'unknown_usage' && <>
          <select className="select" style={{ width: 320 }} data-testid="usage-mode" value={usageMode} onChange={event => setUsageMode(event.target.value as 'usage' | 'reconcile')}>
            <option value="usage">补记用量（按供应商实际回复填写）</option>
            <option value="reconcile">无法核对（保留未知，需说明）</option>
          </select>
          {usageMode === 'usage' && <>
            <input className="input" style={{ width: 120 }} data-testid="usage-input" type="number" min={0} value={inputTokens} onChange={event => setInputTokens(event.target.value)} placeholder="输入 token" />
            <input className="input" style={{ width: 120 }} data-testid="usage-output" type="number" min={0} value={outputTokens} onChange={event => setOutputTokens(event.target.value)} placeholder="输出 token" />
          </>}
          <input className="input" style={{ width: 240 }} data-testid="usage-proof" value={proof} onChange={event => setProof(event.target.value)} placeholder={usageMode === 'usage' ? '用量证据' : '无法核对的说明'} />
        </>}
        {question.kind === 'rework' || question.kind === 'stalled' ? <>
          <Button size="sm" icon="refresh" onClick={() => void submit({ type: 'retry' })}>重试</Button>
          <Button size="sm" onClick={() => void submit({ type: 'respond', value })}>答复</Button>
        </> : <Button size="sm" variant="primary" onClick={() => {
          if (question.kind === 'budget') return void submit({ type: 'add_budget', tokens: Number(tokens) });
          if (question.kind === 'waiting') return void submit({ type: 'respond', value });
          if (question.kind === 'unknown_usage') {
            if (usageMode === 'reconcile') return void submit({ type: 'reconcile_usage', proof });
            return void submit({ type: 'usage', usage: { input: Number(inputTokens), output: Number(outputTokens), cacheRead: 0, cacheWrite: 0 }, proof });
          }
          if (question.kind === 'permission') return void submit({ type: 'grant', grant: question.data.grant });
          if (['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict', 'context_rejected'].includes(question.kind)) return void submit({ type: 'retry' });
          return void submit({ type: 'acknowledge' });
        }}>{['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict', 'context_rejected'].includes(question.kind) ? '重试' : '答复'}</Button>}
      </div>
      {error && <p data-testid="answer-error" style={{ color: 'var(--danger)' }}>{error}</p>}
    </li>
  );
}
