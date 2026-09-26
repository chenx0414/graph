import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { Button, Card, Spinner, Stat } from './ui.tsx';

interface ToolStat {
  tool: string;
  role: string | null;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
}

interface ToolStatsSnapshot {
  generatedAt: number;
  retentionDays: number;
  stats: ToolStat[];
}

const ROLE_LABELS: Record<string, string> = {
  master: '主 Agent',
  coder: '实现 Agent',
  reviewer: '审查 Agent',
  improver: '自改 Agent',
};

function roleLabel(role: string | null): string {
  return role === null ? '未归属' : ROLE_LABELS[role] ?? role;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatWhen(at: number): string {
  if (!at) return '—';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

/**
 * Per-tool telemetry the harness collects itself: how often each tool is called, how often it
 * fails and how long it takes. The numbers come from the durable `tool_calls` table, so they
 * accumulate across reloads instead of dying with the process that happened to observe them.
 */
export function ToolStatsPage() {
  const [snapshot, setSnapshot] = useState<ToolStatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setSnapshot(await api<ToolStatsSnapshot>('/api/tool-stats'));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clear = useCallback(async () => {
    if (!window.confirm('清空后已记录的调用次数、成功率与耗时都会消失。继续？')) return;
    setBusy(true);
    try {
      const response = await fetch('/api/tool-stats/clear', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const stats = snapshot?.stats ?? [];
  const calls = stats.reduce((sum, entry) => sum + entry.calls, 0);
  const errors = stats.reduce((sum, entry) => sum + entry.errors, 0);
  const totalMs = stats.reduce((sum, entry) => sum + entry.totalMs, 0);

  return (
    <section className="usage-page" data-testid="tool-stats-page">
      <header className="usage-page-head">
        <div>
          <h2>工具</h2>
          <p className="card-sub">
            每个工具的调用次数、失败次数与耗时，来自运行期的持久记录
            {snapshot ? `，保留最近 ${snapshot.retentionDays} 天` : ''}。
          </p>
        </div>
        <div className="card-actions">
          <Button onClick={() => void load()} disabled={busy}>{busy ? '读取中…' : '刷新'}</Button>
          <Button onClick={() => void clear()} disabled={busy || calls === 0}>清空记录</Button>
        </div>
      </header>

      <div className="stat-grid" data-testid="tool-stats-summary">
        <Stat label="工具与角色的组合" value={stats.length} />
        <Stat label="调用次数" value={calls} hint={`${errors} 次失败`} />
        <Stat
          label="成功率"
          value={calls ? `${(((calls - errors) / calls) * 100).toFixed(1)}%` : '—'}
          tone={calls === 0 ? undefined : errors ? 'warn' : 'success'}
        />
        <Stat label="平均耗时" value={calls ? formatDuration(totalMs / calls) : '—'} hint={`累计 ${formatDuration(totalMs)}`} />
      </div>

      {error && <Card title="读取失败"><p className="card-sub">{error}</p></Card>}
      {!snapshot && !error && <Card><Spinner label="正在读取工具统计…" /></Card>}
      {snapshot && stats.length === 0 && (
        <Card title="还没有记录" icon="tool" subtitle="发生一次工具调用之后，这里会出现第一行。">
          <p className="card-sub">统计只记录本守护进程内的工具调用，不回溯历史。</p>
        </Card>
      )}
      {stats.length > 0 && (
        <Card title="按工具与角色" icon="tool" subtitle="按调用次数排序">
          <table className="tool-table" data-testid="tool-stats-table">
            <thead>
              <tr>
                <th>工具</th><th>角色</th><th>次数</th><th>失败</th>
                <th>成功率</th><th>平均耗时</th><th>最大耗时</th><th>最近一次</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(entry => (
                <tr data-testid={`tool-stats-row-${entry.tool}`} key={`${entry.tool}/${entry.role ?? ''}`}>
                  <td><code>{entry.tool}</code></td>
                  <td>{roleLabel(entry.role)}</td>
                  <td className="num">{entry.calls}</td>
                  <td className="num">{entry.errors}</td>
                  <td className="num">{(((entry.calls - entry.errors) / entry.calls) * 100).toFixed(1)}%</td>
                  <td className="num">{formatDuration(entry.totalMs / entry.calls)}</td>
                  <td className="num">{formatDuration(entry.maxMs)}</td>
                  <td>{formatWhen(entry.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
