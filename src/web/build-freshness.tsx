import { useEffect, useState } from 'react';
import { api } from './api.ts';

/**
 * A console tab keeps running the bundle it loaded. An update — an RSI reload,
 * an upgrade — leaves the tab looking current while its code is old: measured
 * 2026-11-01, twice a change was reported as "not taking effect" when the page
 * was simply running yesterday's bundle. This says so and offers a refresh; it
 * never reloads under the person's hands.
 */
export function StaleBuildBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const running = [...document.scripts]
      .map(script => script.src.split('/').pop() ?? '')
      .find(name => /^index-.*\.js$/.test(name));
    if (!running) return;
    let stopped = false;
    const check = async () => {
      try {
        const build = await api<{ bundle: string }>('/api/build');
        const served = (build.bundle ?? '').split('/').pop() ?? '';
        if (!stopped && served && served !== running) setStale(true);
      } catch {
        // A console that cannot reach its daemon is not a stale console.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    window.addEventListener('focus', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
  if (!stale) return null;
  return (
    <div
      data-testid="build-stale-banner"
      role="status"
      style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: '6px 12px', background: 'var(--warn, #fff4d6)', borderBottom: '1px solid var(--border, #e3e3e3)', fontSize: 13 }}
    >
      <span>控制台已更新：这个标签页还在跑旧版本。</span>
      <button type="button" className="btn btn-sm" data-testid="build-stale-refresh" onClick={() => location.reload()}>刷新</button>
    </div>
  );
}
