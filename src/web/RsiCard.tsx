import { useState } from 'react';
import { formatElapsed } from './transcript-rsi.ts';
import type { TranscriptRow } from './transcript-model.ts';
import { Icon } from './ui.tsx';

/** The card one applied self-change reports: what changed, what proved it, and
 * what still stands between the reader and the new behaviour - a pending reload,
 * or an app that has to be reopened before its own code is the code it runs. */
export function RsiCard({ row }: { row: Extract<TranscriptRow, { kind: 'rsi' }> }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const { rsi } = row;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? false;
  // The number the reader wants is the price of the call: writing the files,
  // running the gate and committing. The reload is a separate wait with its own
  // label, and a receipt that has not measured its call shows no number at all.
  const elapsedMs = rsi.elapsedMs;
  const dryRunFailed = rsi.status === 'dry_run' && rsi.validation.some(item => item.status === 'failed');
  const statusLabel = rsi.status === 'applied' ? (rsi.activation === 'active' ? '已生效' : rsi.activation === 'pending_reload' ? '等待重载' : '已提交')
    : rsi.status === 'checks_failed' ? '检查未通过'
      : rsi.status === 'dry_run' ? (dryRunFailed ? '演练未通过' : '演练通过')
        : rsi.status === 'rolled_back' ? '已回滚' : '不可用';
  const files = rsi.files.length ? rsi.files : rsi.pendingFiles;
  return (
    <section className="rsi-report" data-testid="rsi-report" data-status={rsi.status}>
      <header className="rsi-report-header">
        <span className="rsi-report-icon" aria-hidden="true"><Icon name="spark" size={14} /></span>
        <div className="rsi-report-heading">
          <strong>{rsi.title}</strong>
          <span className="rsi-report-badge">{statusLabel}</span>
          {elapsedMs !== null && (
            <span className="rsi-report-elapsed" data-testid="rsi-report-elapsed">{`耗时 ${formatElapsed(elapsedMs)}`}</span>
          )}
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
      {rsi.status === 'dry_run' && (
        <p className="rsi-report-pending">演练：改动写进工作区跑过检查后已恢复；没有提交，也不会重载。</p>
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
      {rsi.appInstall && (
        <p className="rsi-report-app" data-testid="rsi-report-app" data-state={rsi.appInstall.state}>
          <Icon name={rsi.appInstall.state === 'installed' ? 'check' : 'alert'} size={12} />
          {rsi.appInstall.state === 'installed'
            ? 'Graph.app 已换成这次构建的包；退出并重开 Graph.app 才会用到它。'
            : `Graph.app 没有更新：${rsi.appInstall.note}　此时重开也不会带上这次改动。`}
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
