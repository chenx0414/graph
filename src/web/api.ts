const pendingReads = new Map<string, Promise<unknown>>();

/** Coalesce concurrent default reads, without caching stale responses or sharing mutations. */
export function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (Object.keys(init).length) {
    const writes = init.method && !['GET', 'HEAD'].includes(init.method.toUpperCase());
    if (writes) pendingReads.clear();
    return request<T>(path, init).finally(() => { if (writes) pendingReads.clear(); });
  }
  const pending = pendingReads.get(path);
  if (pending) return pending as Promise<T>;
  const read = request<T>(path, init).finally(() => {
    if (pendingReads.get(path) === read) pendingReads.delete(path);
  });
  pendingReads.set(path, read);
  return read;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const body = await response.json() as T & { message?: string; code?: string; field?: string };
  if (!response.ok) {
    // A stale session is the one failure a retry cannot fix: the daemon was restarted, so the cookie this
    // page holds is no longer accepted and only a reload gets a new one. Saying that is the difference
    // between a user who reloads and one who reads "Authentication required" and gives up (HB-200).
    const stale = response.status === 401;
    const error = new Error(stale
      ? `${body.message ?? 'Authentication required'}：服务端重载后这个页面的旧会话已失效，刷新页面即可继续。`
      : body.message ?? response.statusText) as Error & { code?: string; field?: string };
    if (body.code) error.code = body.code;
    if (body.field) error.field = body.field;
    throw error;
  }
  return body;
}
