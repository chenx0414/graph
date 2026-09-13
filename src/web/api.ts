export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
