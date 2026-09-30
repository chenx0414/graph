import { USAGE_REFRESHED_EVENT } from './usage-refresh.ts';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { Button, Card, Icon, Pill, Spinner, Stat } from './ui.tsx';

type UsageStatus = 'ok' | 'warning' | 'limited' | 'unconfigured' | 'error';

interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: number | null;
  used?: number;
  limit?: number;
  unit?: string;
}

type UsageProviderId = 'opencode-go' | 'command-goat' | 'deepseek' | 'grok' | 'chatgpt';

interface UsagePlan {
  /** Unique per account: the platform id, or `<platform>#<credentialId>` for an extra account. */
  id: string;
  /** The subscription platform this card reports on. */
  platform: UsageProviderId;
  /** The extra account of that platform, or null for its primary credential. */
  account: { id: string; name: string } | null;
  name: string;
  subtitle: string;
  configured: boolean;
  status: UsageStatus;
  plan: string | null;
  credentialSource: string | null;
  windows: UsageWindow[];
  balance: { remaining?: number; used?: number; total?: number; currency?: string; unit?: string } | null;
  details: Record<string, string | number | null>;
  error: string | null;
  updatedAt: number;
}

interface UsageSnapshot {
  generatedAt: number;
  plans: UsagePlan[];
  summary: { configured: number; connected: number; warnings: number; limited: number; unconfigured: number };
}

const PROVIDER_MARKS: Record<UsageProviderId, string> = {
  'opencode-go': 'OC',
  'command-goat': 'CG',
  deepseek: 'DS',
  grok: 'GK',
  chatgpt: 'GPT',
};

function statusLabel(plan: UsagePlan) {
  if (!plan.configured) return '未配置';
  if (plan.status === 'error') return '查询失败';
  if (plan.status === 'limited') return '额度受限';
  if (plan.status === 'warning') return '接近上限';
  return '正常';
}

function statusTone(plan: UsagePlan): 'neutral' | 'success' | 'warn' | 'danger' {
  if (!plan.configured || plan.status === 'error') return plan.status === 'error' ? 'danger' : 'neutral';
  if (plan.status === 'limited') return 'danger';
  if (plan.status === 'warning') return 'warn';
  return 'success';
}

function percent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function money(value: number, currency?: string, unit?: string) {
  const symbol = unit ?? (currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '');
  return `${symbol}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function resetText(timestamp: number | null) {
  if (!timestamp) return '重置时间未知';
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return '即将重置';
  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`;
  return `${Math.max(1, minutes)} 分钟后重置`;
}

function updatedText(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return '刚刚更新';
  if (seconds < 60) return `${seconds} 秒前更新`;
  return `${Math.floor(seconds / 60)} 分钟前更新`;
}

function windowTone(window: UsageWindow): 'success' | 'warn' | 'danger' {
  if (window.usedPercent >= 100) return 'danger';
  if (window.usedPercent >= 80) return 'warn';
  return 'success';
}

export function UsagePage() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const next = await api<UsageSnapshot>(force ? '/api/usage/refresh' : '/api/usage', force ? { method: 'POST' } : {});
      setSnapshot(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const refreshed = () => { void load(false); };
    window.addEventListener(USAGE_REFRESHED_EVENT, refreshed);
    return () => window.removeEventListener(USAGE_REFRESHED_EVENT, refreshed);
  }, [load]);

  if (loading && !snapshot) return <Card><Spinner label="正在查询订阅用量…" /></Card>;
  if (!snapshot) {
    return <Card title="用量" icon="usage" subtitle="查询订阅计划、配额和剩余额度">
      <p className="muted" data-testid="usage-error">{error || '用量信息暂时不可用。'}</p>
      <Button icon="refresh" onClick={() => void load(false)}>重试</Button>
    </Card>;
  }

  const configured = snapshot.plans.filter(plan => plan.configured);
  const tightest = configured
    .flatMap(plan => plan.windows.map(window => ({ plan, window })))
    .sort((left, right) => right.window.usedPercent - left.window.usedPercent)[0] ?? null;
  return (
    <section className="usage-page" data-testid="usage-page">
      <header className="usage-page-head">
        <div>
          <h2>订阅与额度</h2>
          <p>统一查看已接入订阅的用量窗口和剩余额度。</p>
        </div>
        <Button icon="refresh" disabled={refreshing} onClick={() => void load(true)} data-testid="usage-refresh">
          {refreshing ? '刷新中…' : '刷新用量'}
        </Button>
      </header>

      {error && <div className="hint-card usage-error" data-testid="usage-error">{error}</div>}

      <div className="usage-summary" data-testid="usage-summary">
        <Stat label="已配置订阅" value={`${snapshot.summary.configured} / ${snapshot.plans.length}`} hint={`${snapshot.summary.unconfigured} 个未配置`} />
        <Stat label="连接正常" value={snapshot.summary.connected} hint="本轮成功读取" tone={snapshot.summary.connected === snapshot.summary.configured ? 'success' : undefined} />
        <Stat
          label="最紧张额度"
          value={tightest ? percent(tightest.window.usedPercent) : '—'}
          hint={tightest ? `${tightest.plan.name} · ${tightest.window.label}` : '暂无配额窗口'}
          tone={tightest && tightest.window.usedPercent >= 80 ? 'warn' : undefined}
          progress={tightest?.window.usedPercent}
        />
      </div>

      <div className="usage-section-head">
        <h3>订阅计划</h3>
        <span>{configured.length} 个已接入</span>
      </div>
      <div className="usage-plan-grid">
        {snapshot.plans.map(plan => (
          <article className="usage-plan-card" data-provider={plan.platform} data-testid={`usage-plan-${plan.id}`} key={plan.id}>
            <header className="usage-plan-head">
              <span className="usage-plan-mark" aria-hidden="true">{PROVIDER_MARKS[plan.platform]}</span>
              <div className="usage-plan-title">
                <strong>{plan.name}</strong>
                <span>
                  {plan.account ? <span className="usage-plan-account" data-testid={`usage-plan-account-${plan.id}`}>{plan.account.name}</span> : null}
                  {plan.account ? ' · ' : ''}
                  {plan.subtitle}
                </span>
              </div>
              <Pill tone={statusTone(plan)}>{statusLabel(plan)}</Pill>
            </header>

            <div className="usage-plan-main">
              <div>
                <span className="usage-plan-plan">{plan.plan ?? (plan.configured ? '计划信息未知' : '等待配置')}</span>
                {plan.balance?.remaining !== undefined ? (
                  <strong className="usage-balance">
                    {money(plan.balance.remaining, plan.balance.currency, plan.balance.unit)}
                    <small> 剩余</small>
                  </strong>
                ) : plan.windows.length ? (
                  <strong className="usage-balance">
                    {percent(plan.windows[0]!.remainingPercent)}
                    <small> 剩余额度</small>
                  </strong>
                ) : (
                  <strong className="usage-balance">—</strong>
                )}
              </div>
              {plan.balance?.total !== undefined && plan.balance.used !== undefined && (
                <div className="usage-balance-note">
                  已用 {money(plan.balance.used, plan.balance.currency, plan.balance.unit)} / 共 {money(plan.balance.total, plan.balance.currency, plan.balance.unit)}
                </div>
              )}
            </div>

            <div className="usage-window-list">
              {plan.windows.map(window => (
                <div className="usage-window-row" key={window.id} data-tone={windowTone(window)}>
                  <div className="usage-window-line">
                    <span>{window.label}</span>
                    <strong>{percent(window.usedPercent)}</strong>
                  </div>
                  <div className="usage-progress"><span style={{ width: `${window.usedPercent}%` }} /></div>
                  <div className="usage-window-meta">
                    <span>{resetText(window.resetAt)}</span>
                    {window.used !== undefined && window.limit !== undefined && (
                      <span>{window.unit === 'USD' ? `${money(window.used, 'USD', '$')} / ${money(window.limit, 'USD', '$')}` : `${window.used} / ${window.limit}`}</span>
                    )}
                  </div>
                </div>
              ))}
              {!plan.windows.length && plan.configured && plan.status !== 'error' && (
                <div className="usage-window-empty">当前接口只返回余额，没有周期配额窗口。</div>
              )}
            </div>

            {plan.error && <div className="usage-plan-error" data-testid={`usage-error-${plan.id}`}>{plan.error}</div>}
            {!plan.configured && (
              <div className="usage-plan-empty">
                未检测到凭据。可在模型设置中添加，或登录对应 CLI 后重新刷新。
              </div>
            )}

            <footer className="usage-plan-foot">
              <span>{plan.credentialSource ?? '尚未连接凭据'}</span>
              <span>{plan.configured ? updatedText(plan.updatedAt) : '未接入'}</span>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
