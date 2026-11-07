import { useEffect } from 'react';
import { api } from './api.ts';

export const USAGE_REFRESH_INTERVAL = 5 * 60_000;
export const USAGE_REFRESHED_EVENT = 'graph:usage-refreshed';

let inFlight: Promise<unknown> | undefined;
function refreshUsage() {
  if (!inFlight) inFlight = api('/api/usage/refresh', { method: 'POST' }).finally(() => { inFlight = undefined; });
  return inFlight;
}

export function useUsageRefresh() {
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        await refreshUsage();
        if (!controller.signal.aborted) window.dispatchEvent(new Event(USAGE_REFRESHED_EVENT));
      } catch { /* The usage page retains the last result and displays service errors. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, USAGE_REFRESH_INTERVAL);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
}
