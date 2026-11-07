import { useEffect, useState } from 'react';
import { api } from './api.ts';

const RELOADED_FOR = 'graph-stale-reload';

const COMPOSERS = ['chat-input', 'node-chat-input'];

function composerHasDraft() {
  return COMPOSERS.some(testid => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
    if (!input) return false;
    const value = 'value' in input && typeof (input as HTMLTextAreaElement).value === 'string'
      ? (input as HTMLTextAreaElement).value
      : input.textContent;
    return (value ?? '').trim().length > 0;
  });
}

function dialogOpen() {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

function idleEnoughToReload() {
  return document.visibilityState === 'hidden' || (!composerHasDraft() && !dialogOpen());
}

function runningBundle() {
  const running = [...document.scripts]
    .map(script => script.src.split('/').pop() ?? '')
    .find(name => /^index-.*\.js$/.test(name));
  return running ?? '';
}

export function StaleBuildBanner() {
  const [served, setServed] = useState('');

  useEffect(() => {
    const running = runningBundle();
    if (!running) return;
    let stopped = false;
    const check = async () => {
      let next = '';
      try {
        const build = await api<{ bundle: string }>('/api/build');
        next = (build.bundle ?? '').split('/').pop() ?? '';
      } catch {
        return;
      }
      if (stopped || !next || next === running) return;
      if (sessionStorage.getItem(RELOADED_FOR) === next || !idleEnoughToReload()) {
        setServed(next);
        return;
      }
      sessionStorage.setItem(RELOADED_FOR, next);
      location.reload();
    };
    void check();
    const timer = setInterval(() => void check(), 20_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  if (!served) return null;
  return (
    <div
      data-testid="build-stale-banner"
      role="status"
      style={{
        position: 'sticky', top: 0, zIndex: 60, display: 'flex', gap: 10, alignItems: 'center',
        justifyContent: 'center', padding: '8px 14px', background: 'var(--accent, #2f6feb)', color: '#fff',
        fontSize: 13, fontWeight: 500, boxShadow: '0 1px 0 rgba(0,0,0,.18)',
      }}
    >
      <span>控制台已更新，这个标签页还在跑旧版本（{served}）。刷新后才看得到新功能。</span>
      <button
        type="button"
        data-testid="build-stale-refresh"
        onClick={() => { sessionStorage.removeItem(RELOADED_FOR); location.reload(); }}
        style={{ padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,.7)', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 12.5 }}
      >立即刷新</button>
    </div>
  );
}
