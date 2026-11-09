import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

function read<T>(database: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function streamingProvider() {
  let frames = 0;
  let requests = 0;
  const server: Server = createServer(async (request, response) => {
    requests += 1;
    for await (const _ of request) { /* drain the body */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
    const timer = setInterval(() => {
      frames += 1;
      response.write(frame({ choices: [{ index: 0, delta: { content: '思考中… ' } }] }));
    }, 120);
    response.on('close', () => clearInterval(timer));
  });
  server.keepAliveTimeout = 600_000;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    frames: () => frames,
    requests: () => requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('an interrupted streaming turn never starts a second operation, and the next message runs again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-interrupt-stream-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# project\n');
  execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', project, '-c', 'user.name=T', '-c', 'user.email=t@local', 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'user.name=T', '-c', 'user.email=t@local', 'commit', '-q', '-m', 'baseline']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await streamingProvider();
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_STREAM_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_STREAM_KEY: 'synthetic-key' }, extraArgs: ['--execute'] });
  const database = join(root, 'state', 'tasks.sqlite');
  const cookie = (await fetch(daemon.url)).headers.get('set-cookie') ?? '';
  const post = (path: string, body: unknown) => fetch(`${daemon.url}${path}`, {
    method: 'POST', headers: { origin: daemon.url, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const created = await post('/api/conversations', { projectId: 'p', model: 'local', text: '想一想。', requestId: 'stream-1' });
    expect(created.status, await created.clone().text()).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const taskId = ((await (await fetch(`${daemon.url}/api/conversations/${conversationId}`, { headers: { cookie } })).json()) as { anchorTaskId?: string }).anchorTaskId ?? '';
    const operations = () => read<{ state: string }>(database, "SELECT state FROM operations WHERE task_id=? AND node_id='master' ORDER BY rowid", taskId);

    await expect.poll(() => provider.frames(), { timeout: 60_000, interval: 100 }).toBeGreaterThan(2);
    await expect.poll(() => operations().length, { timeout: 30_000, interval: 100 }).toBe(1);
    const interrupted = await post(`/api/conversations/${conversationId}/interrupt`, { requestId: 'stream-interrupt' });
    expect(interrupted.status, await interrupted.clone().text()).toBe(200);
    await expect.poll(() => operations()[0]?.state, { timeout: 30_000, interval: 100 }).toBe('interrupted');

    const frozenFrames = provider.frames();
    const frozenRequests = provider.requests();
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(operations().length, 'a second master operation started after the interrupt').toBe(1);
    expect(provider.requests(), 'the provider was asked again after the interrupt').toBe(frozenRequests);
    expect(provider.frames(), 'the upstream stream kept writing after the interrupt').toBe(frozenFrames);

    const view = await (await fetch(`${daemon.url}/api/conversations/${conversationId}`, { headers: { cookie } })).json() as { master?: { status?: string } };
    expect(view.master?.status, `the master is still ${view.master?.status}`).not.toBe('running');

    const next = await post(`/api/conversations/${conversationId}/messages`, { text: '继续说。', requestId: 'stream-2' });
    expect(next.status, await next.clone().text()).toBe(200);
    await expect.poll(() => operations().length, { timeout: 30_000, interval: 100 }).toBe(2);
    await expect.poll(() => operations()[1]?.state, { timeout: 30_000, interval: 100 }).not.toBe('pending');
  } finally {
    await daemon.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 180_000);
