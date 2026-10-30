import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { Button, Card, Icon, Spinner, Stat } from './ui.tsx';
import { ToolStatsPage } from './ToolStats.tsx';
import { UsagePage } from './Usage.tsx';
import type { ConversationSummary } from './conversation-types.tsx';
import type { Settings_ } from './app-state.tsx';

/** One billed model, as the record reports it. */
type ModelRow = {
  model: string; provider: string; calls: number;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  costMicros: number; avgMs: number;
};

type ToolRow = {
  tool: string; role: string | null; calls: number; errors: number;
  totalMs: number; medianMs: number; maxMs: number; lastAt: number;
};

type Insights = {
  generatedAt: number;
  scope: { kind: string; id?: string; label?: string };
  overview: { turns: number; steps: number; toolCalls: number; toolErrors: number; costMicros: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cacheHitRate: number };
  timing: { modelMs: number; modelCalls: number; toolMs: number; toolCalls: number };
  models: ModelRow[];
  tools: ToolRow[];
};

function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** The recorded cost, in the currency the provider priced it in. */
function formatCost(micros: number): string {
  if (micros <= 0) return '—';
  const amount = micros / 1e6;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(4)}`;
}

/** The role a tool call ran under; the same tool can appear once per role. */
function roleLabel(role: string | null): string {
  if (!role || role === 'master') return '主 Agent';
  return role;
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const value = (part / whole) * 100;
  return value >= 10 ? `${value.toFixed(0)}%` : `${value.toFixed(1)}%`;
}

type Slice = { key: string; label: string; value: number; color: string };

/** A donut whose arcs are the slices themselves, so the picture cannot drift from the legend. */
function Donut({ slices, total, testid }: { slices: Slice[]; total: number; testid?: string }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg className="insights-donut" viewBox="0 0 140 140" role="img" data-testid={testid} aria-label="构成比例">
      <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--line, #e3e4e6)" strokeWidth="18" />
      {total > 0 && slices.filter(slice => slice.value > 0).map(slice => {
        const length = (slice.value / total) * circumference;
        const dash = `${Math.max(0, length - 2)} ${circumference - Math.max(0, length - 2)}`;
        const element = (
          <circle key={slice.key} cx="70" cy="70" r={radius} fill="none" stroke={slice.color} strokeWidth="18"
            strokeDasharray={dash} strokeDashoffset={-offset} transform="rotate(-90 70 70)" />
        );
        offset += length;
        return element;
      })}
      <text x="70" y="66" textAnchor="middle" className="insights-donut-value">{formatTokens(total)}</text>
      <text x="70" y="84" textAnchor="middle" className="insights-donut-label">tokens</text>
    </svg>
  );
}

/** A horizontal share bar, one row per entry. */
function ShareBars({ rows, testid }: { rows: { key: string; label: string; value: number; hint: string }[]; testid?: string }) {
  const peak = rows.reduce((max, row) => Math.max(max, row.value), 0);
  return (
    <ul className="insights-bars" data-testid={testid}>
      {rows.map(row => (
        <li key={row.key} className="insights-bar-row" data-testid={`insights-bar-${row.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`}>
          <span className="insights-bar-label" title={row.label}>{row.label}</span>
          <span className="insights-bar-track">
            <span className="insights-bar-fill" style={{ width: `${peak > 0 ? (row.value / peak) * 100 : 0}%` }} />
          </span>
          <span className="insights-bar-value">{row.hint}</span>
        </li>
      ))}
    </ul>
  );
}

/** A section that stays closed until asked for.
 *
 * Closed has to mean *not rendered*, not merely hidden: the sections below fetch
 * their own data, and a page that quietly queries the subscription API and the
 * skill scan every time it opens is slower and noisier than the page it replaced.
 */
function Fold({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="insights-fold" data-open={open} data-testid={`insights-fold-${id}`}>
      <button type="button" className="insights-fold-head" aria-expanded={open}
        data-testid={`insights-fold-${id}-toggle`} onClick={() => setOpen(value => !value)}>
        <span className="insights-fold-chevron" data-open={open}><Icon name="chevron" size={14} /></span>
        <span className="insights-fold-title">{title}</span>
        {hint && <span className="insights-fold-hint">{hint}</span>}
      </button>
      {open && <div className="insights-fold-body" data-testid={`insights-fold-${id}-body`}>{children}</div>}
    </section>
  );
}

/**
 * 洞察 is one page for what the installation spent: billed tokens, the models
 * that billed them, the tools that ran beside them, and the two halves of the
 * time. The subscription quota and the tool/skill detail stay the components
 * they already were - the page composes them instead of copying them.
 */
export function InsightsPage({ settings, conversations }: { settings: Settings_ | null; conversations: ConversationSummary[] }) {
  const [scopeKind, setScopeKind] = useState<'global' | 'project' | 'conversation'>('global');
  const [scopeId, setScopeId] = useState('');
  const [snapshot, setSnapshot] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const scopedPath = useMemo(() => {
    const query = new URLSearchParams();
    if (scopeKind !== 'global') {
      query.set('scope', scopeKind);
      query.set('id', scopeId);
    }
    const text = query.toString();
    return text ? `/api/insights?${text}` : '/api/insights';
  }, [scopeKind, scopeId]);

  const ready = scopeKind === 'global' || scopeId !== '';

  const load = useCallback(async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      setSnapshot(await api<Insights>(scopedPath));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
    // The refresh control must re-read, so the request is made directly rather
    // than through the coalescing read cache.
  }, [ready, scopedPath]);

  useEffect(() => { void load(); }, [load]);

  const tokens = snapshot?.tokens;
  const overview = snapshot?.overview;
  const timing = snapshot?.timing;

  const slices: Slice[] = tokens ? [
    { key: 'cacheRead', label: '缓存读', value: tokens.cacheRead, color: 'var(--info, #1d4ed8)' },
    { key: 'input', label: '输入（未命中缓存）', value: tokens.input, color: 'var(--accent, #1a1c1f)' },
    { key: 'output', label: '输出', value: tokens.output, color: 'var(--success, #08783f)' },
    { key: 'cacheWrite', label: '缓存写', value: tokens.cacheWrite, color: 'var(--warn, #b45309)' },
  ] : [];

  const toolRows = snapshot?.tools ?? [];
  const topTools = toolRows.slice(0, 10);
  const modelWall = (timing?.modelMs ?? 0) + (timing?.toolMs ?? 0);

  return (
    <section className="usage-page insights-page" data-testid="insights-page">
      <header className="usage-page-head insights-head">
        <div>
          <h2>洞察</h2>
          <p className="card-sub">用量、工具与耗时来自同一份记录：每个模型调用记一次扣费，每次工具调用记一次耗时。</p>
        </div>
        <div className="insights-scope">
          <label>
            <span className="sr-only">统计范围</span>
            <select
              data-testid="insights-scope-kind"
              value={scopeKind === 'global' ? 'global' : `${scopeKind}:${scopeId}`}
              onChange={event => {
                const value = event.target.value;
                if (value === 'global') { setScopeKind('global'); setScopeId(''); return; }
                const [kind, id] = value.split(':');
                setScopeKind(kind as 'project' | 'conversation');
                setScopeId(id ?? '');
              }}
            >
              <option value="global">全局</option>
              {(settings?.projects ?? []).filter(project => !project.archivedAt).map(project => (
                <option key={project.id} value={`project:${project.id}`}>项目 · {project.id}</option>
              ))}
              {conversations.map(conversation => (
                <option key={conversation.id} value={`conversation:${conversation.id}`}>
                  会话 · {conversation.title || conversation.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <Button icon="refresh" onClick={() => void load()} disabled={busy}>{busy ? '读取中…' : '刷新'}</Button>
        </div>
      </header>

      {error && <Card title="读取失败" icon="alert"><p className="card-sub" data-testid="insights-error">{error}</p></Card>}
      {!snapshot && !error && <Card><Spinner label="正在汇总用量与工具记录…" /></Card>}

      {snapshot && (
        <>
          <div className="stat-grid" data-testid="insights-overview">
            <Stat label="轮次" value={overview?.turns ?? 0} hint={snapshot.scope.kind === 'conversation' ? '本会话' : '全部会话'} />
            <Stat label="模型调用" value={overview?.steps ?? 0} hint={`${formatDuration((timing?.modelMs ?? 0) / Math.max(1, timing?.modelCalls ?? 1))} / 次`} />
            <Stat label="工具调用" value={overview?.toolCalls ?? 0} hint={`${formatDuration((timing?.toolMs ?? 0) / Math.max(1, timing?.toolCalls ?? 1))} / 次`} />
            <Stat
              label="失败率"
              value={overview && overview.toolCalls ? `${((overview.toolErrors / overview.toolCalls) * 100).toFixed(1)}%` : '—'}
              hint={`${overview?.toolErrors ?? 0} 次失败`}
              tone={overview && overview.toolErrors ? 'warn' : 'success'}
            />
            <Stat label="记录成本" value={formatCost(overview?.costMicros ?? 0)} hint="按各模型记录的单价折算" />
          </div>

          <div className="insights-grid">
            <Card title="Token 构成" icon="usage" subtitle="按 provider 上报的计费口径" testid="insights-tokens">
              <div className="insights-donut-row">
                <Donut slices={slices} total={tokens?.total ?? 0} testid="insights-donut" />
                <ul className="insights-legend">
                  {slices.map(slice => (
                    <li key={slice.key} data-testid={`insights-legend-${slice.key}`}>
                      <span className="insights-swatch" style={{ background: slice.color }} />
                      <span className="insights-legend-label">{slice.label}</span>
                      <span className="insights-legend-value">{formatTokens(slice.value)}</span>
                      <span className="insights-legend-share">{percent(slice.value, tokens?.total ?? 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="card-sub" data-testid="insights-cache">
                合计 {formatTokens(tokens?.total ?? 0)} tokens，缓存命中 {(100 * (tokens?.cacheHitRate ?? 0)).toFixed(1)}%
              </p>
            </Card>

            <Card title="耗时分布" icon="clock" subtitle="模型等待与工具执行" testid="insights-timing">
              <div className="insights-split">
                <span style={{ flexGrow: Math.max(1, timing?.modelMs ?? 0) }} className="insights-split-model" />
                <span style={{ flexGrow: Math.max(1, timing?.toolMs ?? 0) }} className="insights-split-tool" />
              </div>
              <ul className="insights-legend">
                <li data-testid="insights-timing-model">
                  <span className="insights-swatch" style={{ background: 'var(--accent, #1a1c1f)' }} />
                  <span className="insights-legend-label">模型调用</span>
                  <span className="insights-legend-value">{formatDuration(timing?.modelMs ?? 0)}</span>
                  <span className="insights-legend-share">{percent(timing?.modelMs ?? 0, modelWall)}</span>
                </li>
                <li data-testid="insights-timing-tool">
                  <span className="insights-swatch" style={{ background: 'var(--info, #1d4ed8)' }} />
                  <span className="insights-legend-label">工具执行</span>
                  <span className="insights-legend-value">{formatDuration(timing?.toolMs ?? 0)}</span>
                  <span className="insights-legend-share">{percent(timing?.toolMs ?? 0, modelWall)}</span>
                </li>
              </ul>
              <p className="card-sub">模型调用 {(timing?.modelCalls ?? 0).toLocaleString()} 次 · 工具调用 {(timing?.toolCalls ?? 0).toLocaleString()} 次</p>
            </Card>
          </div>

          <Card title="模型" icon="bolt" subtitle="按记录成本排序" testid="insights-models">
            {snapshot.models.length === 0
              ? <p className="card-sub">这个范围里还没有模型调用。</p>
              : (
                <table className="tool-table">
                  <thead>
                    <tr><th>模型</th><th>调用</th><th>输入</th><th>缓存读</th><th>输出</th><th>成本</th><th>平均耗时</th></tr>
                  </thead>
                  <tbody>
                    {snapshot.models.map(row => (
                      <tr key={`${row.provider}/${row.model}`} data-testid={`insights-model-${row.model}`}>
                        <td><code>{row.model || '(未知模型)'}</code>{row.provider && <span className="insights-provider">{row.provider}</span>}</td>
                        <td className="num">{row.calls.toLocaleString()}</td>
                        <td className="num">{formatTokens(row.input)}</td>
                        <td className="num">{formatTokens(row.cacheRead)}</td>
                        <td className="num">{formatTokens(row.output)}</td>
                        <td className="num">{formatCost(row.costMicros)}</td>
                        <td className="num">{formatDuration(row.avgMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Card>

          <Card title="工具调用" icon="tool" subtitle="按调用次数排序" testid="insights-tools">
            {topTools.length === 0
              ? <p className="card-sub">这个范围里还没有工具调用。</p>
              : (
                <>
                  <ShareBars
                    testid="insights-tool-bars"
                    rows={topTools.map(row => ({
                      key: `${row.tool}/${row.role ?? ''}`,
                      label: `${row.tool} · ${roleLabel(row.role)}`,
                      value: row.calls,
                      hint: `${row.calls.toLocaleString()} 次 · ${formatDuration(row.totalMs)}`,
                    }))}
                  />
                  <table className="tool-table">
                    <thead>
                      <tr><th>工具</th><th>角色</th><th>次数</th><th>失败</th><th>平均耗时</th><th>中位数</th><th>最大</th></tr>
                    </thead>
                    <tbody>
                      {topTools.map(row => (
                        <tr key={`${row.tool}/${row.role ?? ''}`} data-testid={`insights-tool-row-${row.tool}`}>
                          <td><code>{row.tool}</code></td>
                          <td>{row.role ?? '—'}</td>
                          <td className="num">{row.calls.toLocaleString()}</td>
                          <td className="num">{row.errors}</td>
                          <td className="num">{formatDuration(row.totalMs / Math.max(1, row.calls))}</td>
                          <td className="num">{formatDuration(row.medianMs)}</td>
                          <td className="num">{formatDuration(row.maxMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {toolRows.length > topTools.length && (
                    <p className="card-sub">只列调用最多的 {topTools.length} 项（共 {toolRows.length} 项），完整明细在下方的「工具与技能明细」里。</p>
                  )}
                </>
              )}
          </Card>

          <Fold id="quota" title="订阅额度" hint="订阅计划、剩余额度与重置时间">
            <UsagePage />
          </Fold>

          <Fold id="detail" title="工具与技能明细" hint={`${toolRows.length} 项工具 · 按技能目录匹配`}>
            <ToolStatsPage />
          </Fold>
        </>
      )}
    </section>
  );
}
