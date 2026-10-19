import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { Button } from './ui.tsx';

interface LoginStatus {
  id: string;
  state: 'starting' | 'waiting' | 'saving' | 'complete' | 'cancelled' | 'failed';
  url?: string;
  message?: string;
}

/** Tokens and authorization codes stay in the host. The browser sees only the
 * provider's authorization URL and safe lifecycle status. */
export function ProviderLogin({ credentialRef, configured, onChange }: {
  credentialRef: string;
  configured: boolean;
  onChange: (configured: boolean) => void;
}) {
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
    try { setLogin(await api<LoginStatus>('/api/providers/login', { method: 'POST', body: JSON.stringify({ providerId: 'openrouter', credentialRef }) })); }
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
  return <div className="hint-card provider-login" data-testid="provider-login">
    <div>
      <strong>使用 OpenRouter 账户授权</strong>
      <p className="muted">浏览器授权后将 API key 写入桌面安全存储，也可继续使用下方的 API key。请保持 Graph 桌面 App 打开。</p>
      <div className="row">
        <Button size="sm" disabled={busy || Boolean(pending)} onClick={() => void start()}>授权登录 OpenRouter</Button>
        {login?.state === 'waiting' && login.url && <a href={login.url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm" data-testid="provider-login-open">打开浏览器授权 ↗</a>}
        {pending && <Button size="sm" disabled={busy || login.state === 'saving'} onClick={() => void cancel()}>取消登录</Button>}
        {configured && !pending && <Button size="sm" disabled={busy} onClick={() => void disconnect()}>断开此凭据</Button>}
      </div>
      {login && <p role="status" data-testid="provider-login-status">{{ starting: '正在准备授权…', waiting: '等待你在浏览器中完成授权。', saving: '授权已完成，等待桌面 App 写入安全存储…', complete: '已授权并安全保存，可继续选择模型并验证连接。', cancelled: '登录已取消或超时。', failed: login.message ?? '授权失败，请重试。' }[login.state]}</p>}
      {disconnected && <p role="status">已停用此凭据；桌面 App 将同步移除保存值。若要撤销服务商端密钥，请到 OpenRouter 账户管理。</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  </div>;
}
