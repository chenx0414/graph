import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { Button, Icon, Pill } from './ui.tsx';
import './goal-bar.css';

interface Goal {
  conversationId: string;
  objective: string;
  status: 'active' | 'paused' | 'usage_limited' | 'verifying' | 'completed';
  usedTokens: number;
  acceptance?: string;
  graphId?: string;
  checkNote?: string;
  createdAt: number;
}

const STATUS: Record<Goal['status'], { label: string; tone: 'success' | 'warn' | 'danger' | 'neutral' | 'accent' }> = {
  active: { label: '进行中', tone: 'success' },
  paused: { label: '已暂停', tone: 'warn' },
  usage_limited: { label: '额度用尽', tone: 'warn' },
  verifying: { label: '验收中', tone: 'accent' },
  completed: { label: '已完成', tone: 'neutral' },
};

/** Tokens are counted in the millions here, so the bar prints 1.8M instead of
 * a number nobody reads to the digit. */
function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/** How long the goal has been standing. Rounded to the unit a person would say
 * out loud: an objective that is minutes old is "12 分钟", not a clock face. */
function elapsed(since: number, now: number) {
  const minutes = Math.max(0, Math.round((now - since) / 60_000));
  if (minutes < 1) return '刚刚开始';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** One line, not a card: what the thread is working toward, how long it has
 * been going, what it spent, and the two controls a person needs while it runs.
 * The work itself is in the graph, so there is no link and no transcript entry -
 * the bar is the whole of the goal's presence in the chat. */
export function GoalBar({ conversationId }: { conversationId: string }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  // A poll that started before a click must not overwrite the answer the click
  // brought back: the person sees what their action did, not a stale read.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const started = generation.current;
    try {
      const view = await api<{ goal: Goal | null }>(`/api/conversations/${conversationId}/goal`);
      if (alive.current && started === generation.current) { setGoal(view.goal); setError(''); }
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    }
  }, [conversationId]);

  useEffect(() => {
    alive.current = true;
    void load();
    // The goal changes on its own while it runs (spend, review, completion), and
    // its age is a fact of the clock, so the bar refreshes without being touched.
    const timer = setInterval(() => {
      if (!alive.current) return;
      setNow(Date.now());
      void load();
    }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  async function act(action: string) {
    generation.current += 1;
    setBusy(true); setError('');
    try {
      const result = await api<{ goal: Goal | null }>(`/api/conversations/${conversationId}/goal`, {
        method: 'POST',
        body: JSON.stringify({ action, requestId: `goal-${action}-${Date.now()}` }),
      });
      setGoal(result.goal ?? null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!goal) return null;
  const status = STATUS[goal.status] ?? STATUS.active;
  return <section className="goal-bar" data-status={goal.status} data-testid="goal-bar" data-runner={goal.graphId ? 'graph' : 'conversation'}>
    <Icon name="spark" size={13} />
    <span className="goal-bar-objective" data-testid="goal-objective" title={goal.acceptance ? `${goal.objective}\n\n验收：\n${goal.acceptance}` : goal.objective}>
      {goal.objective}
    </span>
    <Pill tone={status.tone} testid="goal-status">{status.label}</Pill>
    {goal.status !== 'completed' && <span className="goal-bar-fact" data-testid="goal-elapsed">{elapsed(goal.createdAt, now)}</span>}
    <span className="goal-bar-fact" data-testid="goal-usage">{goal.status === 'completed' ? `共 ${compact(goal.usedTokens)} tokens` : `${compact(goal.usedTokens)} tokens`}</span>
    {goal.status === 'active' && <Button size="sm" icon="pause" data-testid="goal-pause" disabled={busy} onClick={() => void act('pause')}>暂停</Button>}
    {(goal.status === 'paused' || goal.status === 'usage_limited') && <Button size="sm" icon="play" data-testid="goal-resume" disabled={busy} onClick={() => void act('resume')}>继续</Button>}
    {goal.status !== 'completed' && <Button size="sm" data-testid="goal-clear" disabled={busy} onClick={() => void act('clear')}>清除</Button>}
    {error && <span className="field-error" role="alert" data-testid="goal-error">{error}</span>}
  </section>;
}
