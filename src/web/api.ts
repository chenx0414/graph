export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? response.statusText);
  return body;
}
