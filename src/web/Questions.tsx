import { useState } from 'react';
import { api } from './api.ts';
import { describeQuestion } from './labels.ts';
import { Markdown } from './Markdown.tsx';
import { Button, Pill, toast } from './ui.tsx';

function questionPrompt(kind: string, data: Record<string, unknown>) {
  const text = (key: string) => typeof data[key] === 'string' && String(data[key]).trim() ? String(data[key]).trim() : undefined;
  // A problem the harness handed over after nobody acted on it: say that first,
  // so the card reads as "this waited for you", not as a fresh incident.
  const escalated = text('escalationPrompt');
  if (escalated) return escalated;
  // The agent's own question: what it asks, and what its answer changes.
  if (kind === 'waiting' && data.requestType === 'user_decision') {
    const prompt = text('prompt');
    const why = text('why');
    if (prompt && why) return `${prompt}（会改变：${why}）`;
    if (prompt) return prompt;
    return '主 Agent 需要你的一个决定。';
  }
  if (kind === 'permission') {
    const grant = text('grant');
    return grant ? `执行需要你授权：${grant}` : '执行需要你确认一项外部权限。';
  }
  if (kind === 'budget' || kind === 'reservation_exceeded') return '该 Agent 已达到当前额度边界，需要你决定是否追加预算。';
  if (kind === 'human_check') return text('prompt') ?? '需要你完成一项人工验收。';
  if (kind === 'system_change') {
    const title = text('title');
    const problem = text('problem');
    return title && problem ? `${title}：${problem}` : title ?? '主 Agent 发现了一项需要你批准的系统优化。';
  }
  return text('prompt') ?? text('reason') ?? text('message') ?? '这项操作需要你确认。';
}

const MINUTE = 60_000;

/**
 * How long the user has been sitting on this question, in words.
 *
 * An unanswered question used to look exactly like work in progress: the card
 * said what was asked and nothing else. The wait is the one fact that tells
 * the person "this is still on you, and for how long" - and past the published
 * deadline it stops being a note and becomes a warning.
 */
function questionWaitText(question: { waitedMs?: number | null; overdueAfterMs?: number; overdue?: boolean; suspendedAfterMs?: number; suspended?: boolean }) {
  if (typeof question.waitedMs !== 'number') return null;
  const minutes = Math.floor(question.waitedMs / MINUTE);
  const waited = minutes < 1 ? '不到 1 分钟' : `${minutes} 分钟`;
  if (question.suspended) {
    const limit = Math.round((question.suspendedAfterMs ?? 0) / MINUTE);
    return limit > 0
      ? `已等待 ${waited}（已挂起：超过 ${limit} 分钟无人回答，不再算进行中）`
      : `已等待 ${waited}（已挂起）`;
  }
  if (question.overdue) {
    const limit = Math.round((question.overdueAfterMs ?? 0) / MINUTE);
    return limit > 0 ? `已等待 ${waited}（超过 ${limit} 分钟仍未回答）` : `已等待 ${waited}（仍未回答）`;
  }
  return `已等待 ${waited}`;
}

/** One open question answered through the authenticated task command path. */
export function QuestionReply({ taskId, question, onDone }: {
  taskId: string;
  question: { id: string; kind: string; data: { prompt?: string; grant?: string; reason?: string; output?: unknown } & Record<string, unknown>; waitedMs?: number | null; overdueAfterMs?: number; overdue?: boolean; suspendedAfterMs?: number; suspended?: boolean };
  onDone: () => void;
}) {
  const [tokens, setTokens] = useState('100000');
  const [inputTokens, setInputTokens] = useState('0');
  const [outputTokens, setOutputTokens] = useState('0');
  const [value, setValue] = useState('');
  const [choices, setChoices] = useState<string[]>([]);
  const [proof, setProof] = useState('');
  const [usageMode, setUsageMode] = useState<'usage' | 'reconcile'>('usage');
  const [error, setError] = useState('');
  const decision = question.kind === 'waiting' && question.data.requestType === 'user_decision';
  const waitText = questionWaitText(question);
  const options = decision && Array.isArray(question.data.options)
    ? question.data.options.filter((option): option is string => typeof option === 'string' && Boolean(option.trim()))
    : [];
  const multiple = question.data.multiple === true;
  const selectedAnswer = multiple ? [...choices, ...(value.trim() ? [value.trim()] : [])] : value.trim() || choices[0] || '';
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
    <li className="list-item question-reply" data-testid={`question-reply-${question.id}`}>
      <div className="question-reply-heading">
        <Pill tone="warn">{describeQuestion(question.kind, question.data)}</Pill>
        {!decision && <code className="faint">{question.kind}</code>}
        <div className="question-reply-prompt"><Markdown text={decision ? String(question.data.prompt ?? '主 Agent 需要你的一个决定。') : questionPrompt(question.kind, question.data)} /></div>
      </div>
      {waitText && <div className={`question-wait${question.suspended ? ' suspended' : question.overdue ? ' overdue' : ''}`} data-testid={`question-waiting-${question.id}`} data-overdue={question.overdue ? 'true' : 'false'} data-suspended={question.suspended ? 'true' : 'false'}>{waitText}</div>}
      {decision && typeof question.data.why === 'string' && <div className="question-reply-why"><Markdown text={question.data.why} /></div>}
      <details style={{ maxWidth: '100%', margin: '4px 0' }}>
        <summary className="muted" style={{ cursor: 'pointer' }}>查看技术详情</summary>
        <pre data-testid={`question-data-${question.id}`} style={{ maxWidth: '100%', margin: '4px 0', fontSize: 12 }}>{JSON.stringify(question.data, null, 2)}</pre>
      </details>
      <div className="row">
        {question.kind === 'budget' && <input className="input" style={{ width: 130 }} data-testid="budget-tokens" type="number" min={1} value={tokens} onChange={event => setTokens(event.target.value)} />}
        {decision && <div className="question-answer-options">
          {options.length > 0 && <div className="question-option-list" role="group" aria-label="选择答复">
            {options.map(option => <label className="question-option" key={option}>
              <input type={multiple ? 'checkbox' : 'radio'} name={`question-${question.id}`} checked={choices.includes(option)} onChange={() => {
                setChoices(current => multiple ? current.includes(option) ? current.filter(item => item !== option) : [...current, option] : [option]);
                if (!multiple) setValue('');
              }} />
              <Markdown text={option} />
            </label>)}
          </div>}
          <textarea className="input question-custom-answer" data-testid="waiting-value" value={value} onChange={event => {
            setValue(event.target.value);
            if (!multiple) setChoices([]);
          }} placeholder={options.length ? '自定义回答…' : '写下你的决定…'} rows={2} />
        </div>}
        {question.kind === 'waiting' && !decision && <input className="input" style={{ width: 220 }} data-testid="waiting-value" value={value} onChange={event => setValue(event.target.value)} placeholder="外部条件已满足的说明" />}
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
        {question.kind === 'human_check' && <input className="input" style={{ width: 260 }} data-testid="human-reason" value={value} onChange={event => setValue(event.target.value)} placeholder="若需驳回，写下具体问题" />}
        {question.kind === 'system_change' ? <>
          <Button size="sm" variant="primary" icon="check" onClick={() => void submit({ type: 'respond', value: { decision: 'approved' } })}>批准并执行</Button>
          <Button size="sm" variant="danger" icon="close" onClick={() => void submit({ type: 'respond', value: { decision: 'rejected' } })}>拒绝</Button>
        </> : question.kind === 'rework' || question.kind === 'stalled' ? <>
          <Button size="sm" icon="refresh" onClick={() => void submit({ type: 'retry' })}>重试</Button>
          <Button size="sm" onClick={() => void submit({ type: 'respond', value })}>答复</Button>
        </> : question.kind === 'human_check' ? <>
          <Button size="sm" variant="primary" icon="check" onClick={() => void submit({ type: 'acknowledge' })}>确认通过</Button>
          <Button size="sm" variant="danger" icon="close" onClick={() => void submit({ type: 'reject', ...(value.trim() ? { reason: value.trim() } : {}) })}>驳回并返工</Button>
        </> : <Button size="sm" variant="primary" disabled={decision && (multiple ? (selectedAnswer as string[]).length === 0 : !selectedAnswer)} onClick={() => {
          if (question.kind === 'budget') return void submit({ type: 'add_budget', tokens: Number(tokens) });
          if (question.kind === 'waiting') return void submit({ type: 'respond', value: decision ? selectedAnswer : value });
          if (question.kind === 'unknown_usage') {
            if (usageMode === 'reconcile') return void submit({ type: 'reconcile_usage', proof });
            return void submit({ type: 'usage', usage: { input: Number(inputTokens), output: Number(outputTokens), cacheRead: 0, cacheWrite: 0 }, proof });
          }
          if (question.kind === 'permission') return void submit({ type: 'grant', grant: question.data.grant });
          if (['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict', 'context_rejected'].includes(question.kind)) return void submit({ type: 'retry' });
          return void submit({ type: 'acknowledge' });
        }}>{decision ? '提交答复' : ['adapter_error', 'execution_failed', 'model_unavailable', 'git_conflict', 'context_rejected'].includes(question.kind) ? '重试' : '答复'}</Button>}
      </div>
      {error && <p data-testid="answer-error" style={{ color: 'var(--danger)' }}>{error}</p>}
    </li>
  );
}
