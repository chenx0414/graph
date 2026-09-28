import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../../src/web/api.ts';

afterEach(() => vi.unstubAllGlobals());

test('concurrent readers share a request, but later reads fetch fresh data', async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', fetch);
  const first = api('/api/example');
  const second = api('/api/example');
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve(Response.json({ version: 1 }));
  expect(await Promise.all([first, second])).toEqual([{ version: 1 }, { version: 1 }]);
  const next = api('/api/example');
  expect(fetch).toHaveBeenCalledTimes(2);
  resolve(Response.json({ version: 2 }));
  expect(await next).toEqual({ version: 2 });
});

test('failed reads can be retried and writes are never coalesced', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ message: 'failed' }, { status: 500 }))
    .mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
  vi.stubGlobal('fetch', fetch);
  await expect(api('/api/example')).rejects.toThrow('failed');
  await expect(api('/api/example')).resolves.toEqual({ ok: true });
  await Promise.all([api('/api/example', { method: 'POST' }), api('/api/example', { method: 'POST' })]);
  expect(fetch).toHaveBeenCalledTimes(4);
});

test('a read after a mutation cannot join an older in-flight snapshot', async () => {
  const resolvers: ((response: Response) => void)[] = [];
  const fetch = vi.fn(() => new Promise<Response>(resolve => resolvers.push(resolve)));
  vi.stubGlobal('fetch', fetch);
  const oldRead = api('/api/example');
  const write = api('/api/example', { method: 'POST' });
  resolvers[1]!(Response.json({ ok: true }));
  await write;
  const freshRead = api('/api/example');
  expect(fetch).toHaveBeenCalledTimes(3);
  resolvers[0]!(Response.json({ version: 1 }));
  await oldRead;
  // Settling the old read must not evict the newer in-flight read.
  const concurrent = api('/api/example');
  expect(fetch).toHaveBeenCalledTimes(3);
  resolvers[2]!(Response.json({ version: 2 }));
  expect(await Promise.all([freshRead, concurrent])).toEqual([{ version: 2 }, { version: 2 }]);
});
