import { createServer, type Server } from 'node:http';
import { expect, test } from 'vitest';
import { unansweredRequestReport } from './cli-daemon.ts';

async function serve(handler: (res: import('node:http').ServerResponse) => void) {
  const server: Server = createServer((_req, res) => handler(res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('an unanswered request is reported as a stalled route while the daemon still answers', async () => {
  const live = await serve(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  try {
    const report = await unansweredRequestReport(live.baseUrl, '/api/tasks/t/graph/control', {}, { timeoutMs: 60_000, probeMs: 2_000 });
    expect(report).toContain('/api/tasks/t/graph/control');
    expect(report).toContain('/api/conversations answered 200');
    expect(report).toContain('alive');
  } finally { await live.close(); }
});

test('an unanswered request is reported as a wedged daemon when nothing answers', async () => {
  const silent = await serve(() => { /* never answers */ });
  try {
    const report = await unansweredRequestReport(silent.baseUrl, '/api/tasks/t/graph/control', {}, { timeoutMs: 60_000, probeMs: 300 });
    expect(report).toContain('wedged');
    expect(report).toContain('no answer within 300ms');
  } finally { await silent.close(); }
});
