import { useEffect, useState } from 'react';
import type { AccessPolicy } from '../core/access-policy.ts';
import { api } from './api.ts';
import { FULL_ACCESS, STANDARD_ACCESS } from './access-presets.ts';
import { Icon, toast } from './ui.tsx';

type ConfigPayload = {
  projects?: unknown[];
  models?: Record<string, unknown> | null;
  credentials?: Record<string, Record<string, unknown>>;
  limits?: Record<string, unknown>;
  access?: AccessPolicy;
};

type ConfigResponse = { revision: number; config: ConfigPayload };
type SaveResponse = { revision: number; applied?: boolean; reason?: string };

function configDocument(config: ConfigPayload) {
  const credentials: Record<string, Record<string, unknown>> = {};
  for (const [id, credential] of Object.entries(config.credentials ?? {})) {
    const next = { ...credential };
    delete next.configured;
    credentials[id] = next;
  }
  return {
    version: 1,
    projects: config.projects ?? [],
    ...(config.models ? { models: config.models } : {}),
    credentials,
    limits: config.limits ?? {},
    access: config.access ?? STANDARD_ACCESS,
  };
}

export function FullAccessToggle() {
  const [full, setFull] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api<ConfigResponse>('/api/config')
      .then(response => {
        if (!cancelled) setFull(response.config.access?.mode === 'full');
      })
      .catch(reason => {
        if (!cancelled) toast(`读取访问模式失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (busy || full === null) return;
    setBusy(true);
    try {
      const current = await api<ConfigResponse>('/api/config');
      const next = current.config.access?.mode !== 'full';
      const document = configDocument(current.config);
      document.access = next ? FULL_ACCESS : STANDARD_ACCESS;
      const saved = await api<SaveResponse>('/api/config', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current.revision, document }),
      });
      if (saved.applied === false) throw new Error(saved.reason ?? '配置未生效');
      setFull(next);
      window.dispatchEvent(new Event('graph:settings-changed'));
      toast(next ? '已开启完全访问' : '已关闭完全访问', next ? 'info' : 'success');
    } catch (reason) {
      toast(`切换完全访问失败：${reason instanceof Error ? reason.message : String(reason)}`, 'danger');
      try {
        const current = await api<ConfigResponse>('/api/config');
        setFull(current.config.access?.mode === 'full');
      } catch {
        setFull(null);
      }
    } finally {
      setBusy(false);
    }
  }

  const active = full === true;
  return (
    <button
      type="button"
      className="full-access-toggle"
      data-testid="full-access-toggle"
      data-active={active}
      aria-pressed={active}
      aria-label={active ? '关闭完全访问' : '开启完全访问'}
      title={active ? '关闭完全访问' : '开启完全访问'}
      disabled={busy || full === null}
      onClick={() => void toggle()}
    >
      <Icon name="alert" size={14} />
      <span>完全访问</span>
    </button>
  );
}
