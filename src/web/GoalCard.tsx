import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { Button, Icon, Pill } from './ui.tsx';
import './goal-card.css';

interface Goal {
  conversationId: string;
  objective: string;
  status: 'active' | 'paused' | 'budget_limited' | 'completed';
  budgetTokens: number;
  usedTokens: number;
  checkNote?: string;
}

const STATUS: Record<Goal['status'], { label: string; tone: 'success' | 'warn' | 'danger' | 'neutral' | 'accent' }> = {
  active: { label: '进行中', tone: 'success' },
  paused: { label: '已暂停', tone: 'warn' },
  budget_limited: { label: '预算用完', tone: 'danger' },
  completed: { label: '已完成', tone: 'neutral' },
};

function compact(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

/** The standing goal of one conversation, as the person manages it: what the
 * thread is working toward, what it has spent, and the actions /goal offers as
 * commands. A conversation without a goal renders nothing. */
export function GoalCard({ conversationId }: { conversationId: string }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('10000');
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const view = await api<{ goal: Goal | null }>(`/api/conversations/${conversationId}/goal`);
      if (alive.current) { setGoal(view.goal); setError(''); }
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    alive.current = true;
    void load();
    // The goal also changes while a turn is running (usage and the budget
    // cutoff happen in the daemon), so the card refreshes on its own.
    const timer = setInterval(() => { void load(); }, 4000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try {
      const result = await api<{ goal: Goal | null }>(`/api/conversations/${conversationId}/goal`, {
        method: 'POST',
        body: JSON.stringify({ action, requestId: `goal-${action}-${Date.now()}`, ...extra }),
      });
      setGoal(result.goal ?? null);
      setClosing(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !goal) return null;
  const status = STATUS[goal.status] ?? STATUS.active;
  const spent = goal.budgetTokens > 0 ? Math.min(100, Math.round((goal.usedTokens / goal.budgetTokens) * 100)) : 0;
  return <section className="goal-card" data-testid="goal-card" data-status={goal.status}>
    <div className="goal-card-head">
      <Icon name="spark" size={15} />
      <strong>会话目标</strong>
      <Pill tone={status.tone} testid="goal-status">{status.label}</Pill>
      <span className="goal-card-usage" data-testid="goal-usage">
        已用 {compact(goal.usedTokens)} / {goal.budgetTokens > 0 ? compact(goal.budgetTokens) : '未设预算'} tokens
      </span>
    </div>
    <p className="goal-card-objective" data-testid="goal-objective">{goal.objective}</p>
    {goal.budgetTokens > 0 && <div className="goal-card-meter" aria-hidden="true"><span style={{ width: `${spent}%` }} data-testid="goal-meter" /></div>}
    {goal.checkNote && <p className="muted" data-testid="goal-note">完成备注：{goal.checkNote}</p>}
    <div className="row goal-card-actions">
      {goal.status === 'active' && <Button size="sm" icon="pause" data-testid="goal-pause" disabled={busy} onClick={() => void act('pause')}>暂停目标</Button>}
      {(goal.status === 'paused' || goal.status === 'budget_limited') && <Button size="sm" icon="play" data-testid="goal-resume" disabled={busy} onClick={() => void act('resume')}>恢复目标</Button>}
      <span className="goal-card-extend">
        <input className="input" style={{ width: 96 }} type="number" min={1} step={1000} value={amount} data-testid="goal-extend-amount" onChange={event => setAmount(event.target.value)} />
        <Button size="sm" icon="plus" data-testid="goal-extend" disabled={busy} onClick={() => void act('extend', { budgetTokens: Number(amount) })}>追加预算</Button>
      </span>
      {goal.status !== 'completed' && (!closing
        ? <Button size="sm" icon="check" data-testid="goal-done" disabled={busy} onClick={() => setClosing(true)}>标记完成</Button>
        : <span className="goal-card-extend">
            <input className="input" style={{ width: 180 }} placeholder="完成备注（可选）" value={note} data-testid="goal-note-input" onChange={event => setNote(event.target.value)} />
            <Button size="sm" data-testid="goal-done-confirm" disabled={busy} onClick={() => void act('done', { checkNote: note })}>确认完成</Button>
            <Button size="sm" data-testid="goal-done-cancel" disabled={busy} onClick={() => { setClosing(false); setNote(''); }}>取消</Button>
          </span>)}
      <Button size="sm" icon="close" data-testid="goal-clear" disabled={busy} onClick={() => void act('clear')}>清除目标</Button>
    </div>
    {error && <p className="field-error" role="alert" data-testid="goal-error">{error}</p>}
  </section>;
}
