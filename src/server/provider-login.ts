import { randomUUID } from 'node:crypto';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { RuntimeError } from '../core/types.ts';

type LoginState = 'starting' | 'waiting' | 'saving' | 'complete' | 'cancelled' | 'failed';
interface Login {
  id: string;
  ref: string;
  state: LoginState;
  url?: string;
  controller: AbortController;
  task: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

/** One host owns each authorization and writes only through the existing desktop
 * secret channel. Status is deliberately constructed from non-secret fields. */
export function createProviderLogins(services: {
  pushSecret(ref: string, value: string | null): Promise<{ applied: boolean }>;
  pendingSecretRequests(): { ref: string }[];
}) {
  const logins = new Map<string, Login>();
  const disconnecting = new Set<string>();
  const view = (login: Login) => ({
    id: login.id, providerId: 'openrouter', credentialRef: login.ref,
    state: login.state === 'complete' && services.pendingSecretRequests().some(request => request.ref === login.ref) ? 'saving' : login.state,
    ...(login.url && login.state === 'waiting' ? { url: login.url } : {}),
    ...(login.state === 'failed' ? { message: '授权未完成，请重试；若已在服务商创建密钥，可在其账户中撤销。' } : {}),
  });
  const get = (id: string) => {
    const login = logins.get(id);
    if (!login) throw new RuntimeError('invalid_input', '登录流程不存在或已过期');
    return login;
  };
  const cancel = async (login: Login) => {
    // Once publishing starts, let the secret write settle. A disconnect waits
    // for that write before revoking, so a late login cannot restore a key.
    if (login.state !== 'saving' && login.state !== 'complete' && login.state !== 'failed') {
      login.state = 'cancelled';
      login.controller.abort();
    }
    await login.task;
    clearTimeout(login.timer);
  };
  return {
    start(providerId: unknown, ref: unknown) {
      if (providerId !== 'openrouter') throw new RuntimeError('invalid_input', '该服务商尚未启用浏览器授权');
      if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new RuntimeError('invalid_input', '凭据引用无效');
      if (disconnecting.has(ref)) throw new RuntimeError('invalid_input', '正在断开此凭据，请稍后重试');
      for (const login of logins.values()) {
        if (login.ref === ref && ['starting', 'waiting', 'saving'].includes(view(login).state)) return view(login);
      }
      // Bounded, short-lived authorization state; never write auth URLs to disk.
      for (const [id, login] of logins) {
        if (logins.size < 16) break;
        if (['complete', 'failed', 'cancelled'].includes(view(login).state)) logins.delete(id);
      }
      if (logins.size >= 16) throw new RuntimeError('invalid_input', '登录流程过多，请先取消已有流程');
      const controller = new AbortController();
      const login: Login = { id: randomUUID(), ref, state: 'starting', controller, task: Promise.resolve(), timer: setTimeout(() => controller.abort(), 5 * 60_000) };
      logins.set(login.id, login);
      login.task = (async () => {
        try {
          const oauth = openrouterProvider().auth.oauth!;
          const credential = await oauth.login({
            signal: controller.signal,
            notify(event) {
              if (event.type === 'auth_url' && !controller.signal.aborted) {
                const url = new URL(event.url);
                if (url.origin !== 'https://openrouter.ai' || url.pathname !== '/auth') throw new Error('Unexpected authorization URL');
                const callback = new URL(url.searchParams.get('callback_url') ?? '');
                if (callback.hostname !== '127.0.0.1' || callback.protocol !== 'http:') throw new Error('Non-loopback callback');
                login.url = event.url;
                login.state = 'waiting';
              }
            },
            // This app runs on the same machine as the browser. Pi's callback
            // wins the race; no authorization code/token ever enters renderer state.
            prompt(prompt) {
              return new Promise<string>((_resolve, reject) => {
                const signal = prompt.signal ?? controller.signal;
                if (signal.aborted) reject(new Error('Cancelled'));
                else signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
              });
            },
          });
          if (controller.signal.aborted) { login.state = 'cancelled'; return; }
          login.state = 'saving';
          const stored = await services.pushSecret(login.ref, credential.access);
          if (!stored.applied) throw new Error('Secret write refused');
          login.state = 'complete';
        } catch {
          if (login.state !== 'cancelled') login.state = controller.signal.aborted ? 'cancelled' : 'failed';
        } finally {
          clearTimeout(login.timer);
          delete login.url;
        }
      })();
      return view(login);
    },
    status(id: string) { return view(get(id)); },
    async cancel(id: string) { const login = get(id); await cancel(login); return view(login); },
    async disconnect(ref: unknown) {
      if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new RuntimeError('invalid_input', '凭据引用无效');
      if (disconnecting.has(ref)) throw new RuntimeError('invalid_input', '正在断开此凭据，请稍后重试');
      disconnecting.add(ref);
      try {
        for (const login of logins.values()) if (login.ref === ref) await cancel(login);
        const revoked = await services.pushSecret(ref, null);
        if (!revoked.applied) throw new RuntimeError('invalid_config', '撤销未能持久化，连接仍然保留，请重试');
        for (const [id, login] of logins) if (login.ref === ref) logins.delete(id);
        return { disconnected: true, persistencePending: services.pendingSecretRequests().some(request => request.ref === ref) };
      } finally { disconnecting.delete(ref); }
    },
    async close() { await Promise.all([...logins.values()].map(cancel)); logins.clear(); },
  };
}
