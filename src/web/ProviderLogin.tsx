import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { Button } from './ui.tsx';

interface LoginStatus {
  id: string;
  providerId: string;
  state: 'starting' | 'waiting' | 'saving' | 'complete' | 'cancelled' | 'failed' | 'expired';
  url?: string;
  userCode?: string;
  message?: string;
}

interface LoginCopy {
  title: string;
  description: string;
  action: string;
  open: string;
  waiting: string;
  saving: string;
  complete: string;
  cancelled: string;
  failed: string;
}

const COPY: Record<string, LoginCopy> = {
  openrouter: {
    title: '使用 OpenRouter 账户授权',
    description: '浏览器授权后将 API key 写入桌面安全存储，也可继续使用下方的 API key。请保持 Graph 桌面 App 打开。',
    action: '授权登录 OpenRouter',
    open: '打开浏览器授权 ↗',
    waiting: '等待你在浏览器中完成授权。',
    saving: '授权已完成，等待桌面 App 写入安全存储…',
    complete: '已授权并安全保存，可继续选择模型并验证连接。',
    cancelled: '登录已取消或超时。',
    failed: '授权失败，请重试。',
  },
  xai: {
    title: '使用 xAI (Grok) 账号登录',
    description: '点击后向 x.ai 申请一次性设备码，在浏览器里登录并确认该码即可；访问令牌只写入桌面安全存储，不需要 API key。设备码 30 分钟内有效。',
    action: '生成 xAI 登录码',
    open: '打开 xAI 授权页 ↗',
    waiting: '在打开的 xAI 页面确认授权；这里每 5 秒自动检查一次。',
    saving: '授权已通过，正在把访问令牌写入本机安全存储…',
    complete: '已登录 xAI 账号并安全保存访问令牌，到期前会自动刷新。',
    cancelled: '登录已取消或设备码已过期，请重新生成。',
    failed: '登录未完成，请重试。',
  },
};

export function ProviderLogin({ providerId = 'openrouter', credentialRef, configured, onChange }: {
  providerId?: string;
  credentialRef: string;
  configured: boolean;
  onChange: (configured: boolean) => void;
}) {
  const copy = COPY[providerId] ?? COPY.openrouter;
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const change = useRef(onChange);
  change.current = onChange;
  const id = login?.id;
  const pending = login && ['starting', 'waiting', 'saving'].includes(login.state);
  useEffect(() => {
    if (!id || !pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<LoginStatus>(`/api/providers/login/${id}`);
        if (stopped) return;
        setLogin(next);
        setError('');
        if (next.state === 'complete') change.current(true);
        else if (['starting', 'waiting', 'saving'].includes(next.state)) timer = setTimeout(() => { void poll(); }, 1000);
      } catch (failure) {
        if (!stopped) { setError((failure as Error).message); timer = setTimeout(() => { void poll(); }, 3000); }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, Boolean(pending)]);

  async function start() {
    setBusy(true); setError(''); setDisconnected(false);
    try { setLogin(await api<LoginStatus>('/api/providers/login', { method: 'POST', body: JSON.stringify({ providerId, credentialRef }) })); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!id) return;
    setBusy(true);
    try {
      const next = await api<LoginStatus>(`/api/providers/login/${id}/cancel`, { method: 'POST' });
      setLogin(next);
      if (next.state === 'complete') change.current(true);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError('');
    try {
      await api('/api/providers/disconnect', { method: 'POST', body: JSON.stringify({ credentialRef }) });
      setLogin(null); setDisconnected(true); change.current(false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const status = login && ({
    starting: providerId === 'xai' ? '正在向 x.ai 申请设备码…' : '正在准备授权…',
    waiting: copy.waiting,
    saving: copy.saving,
    complete: copy.complete,
    cancelled: copy.cancelled,
    failed: login.message ?? copy.failed,
    expired: copy.cancelled,
  } as Record<string, string>)[login.state];
  return <div className="hint-card provider-login" data-testid="provider-login" data-provider={providerId}>
    <div>
      <strong>{copy.title}</strong>
      <p className="muted">{copy.description}</p>
      <div className="row">
        <Button size="sm" disabled={busy || Boolean(pending)} onClick={() => void start()} data-testid="provider-login-start">{copy.action}</Button>
        {login?.state === 'waiting' && login.url && <a href={login.url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm" data-testid="provider-login-open">{copy.open}</a>}
        {pending && <Button size="sm" disabled={busy || login.state === 'saving'} onClick={() => void cancel()}>取消登录</Button>}
        {configured && !pending && <Button size="sm" disabled={busy} onClick={() => void disconnect()}>断开此凭据</Button>}
      </div>
      {login?.state === 'waiting' && login.userCode && <p className="provider-login-code" data-testid="provider-login-code">
        <span className="muted">在 xAI 页面输入这个码：</span> <code className="mono">{login.userCode}</code>
      </p>}
      {status && <p role="status" data-testid="provider-login-status">{status}</p>}
      {disconnected && <p role="status">已停用此凭据；桌面 App 将同步移除保存值。若要撤销服务商端授权，请到服务商账户管理。</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  </div>;
}
