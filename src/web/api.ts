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
    const error = new Error(body.message ?? response.statusText) as Error & { code?: string; field?: string };
    if (body.code) error.code = body.code;
    if (body.field) error.field = body.field;
    throw error;
  }
  return body;
}
