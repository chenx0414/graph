import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { startGraphDaemon } from '../../src/server/start.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('native RSI tools explain malformed model calls and execute the corrected revision against real Git and checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-rsi-shape-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  const git = (args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  await writeFile(join(checkout, 'package.json'), '{"name":"rsi-shape-fixture"}\n');
  await writeFile(join(checkout, 'replace.txt'), 'original\n');
  await writeFile(join(checkout, 'delete.txt'), 'remove me\n');
  await writeFile(join(checkout, 'mirror.txt'), 'revision content\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@local']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'initial']);
  const initialCommit = git(['rev-parse', 'HEAD']);
  const base = { title: 'Correct native RSI call', problem: 'Exercise real model correction', activate: false };
  const check = { command: 'node', args: ['-e', "if(require('node:fs').readFileSync('replace.txt','utf8')!=='corrected\\n')process.exit(1)"] };
  const malformed = [
    { id: 'nested-check', args: { ...base, changes: [{ path: 'a.ts', action: 'write', content: 'x', checks: [check] }] }, expected: /changes\[0\][\s\S]*"checks"[\s\S]*nested one level too deep/ },
    { id: 'nested-edit', args: { ...base, changes: [{ path: 'a.ts', action: 'replace', edits: [{ oldText: 'a', newText: 'b' }, { path: 'b.ts', action: 'write', content: 'y' }] }] }, expected: /changes\[0\]\.edits\[1\][\s\S]*belongs in changes\[\][\s\S]*nested inside another/ },
    { id: 'change-in-checks', args: { ...base, changes: [], checks: [{ path: 'a.ts', action: 'write', content: 'x' }] }, expected: /checks\[0\][\s\S]*belongs in changes\[\]/ },
    { id: 'missing-first', args: { ...base, changes: [{ action: 'replace', edits: [{ oldText: 'a', newText: 'b' }] }] }, expected: /changes\[0\][\s\S]*is missing "path"[\s\S]*one path per file[\s\S]*\{path, action/ },
    { id: 'missing-second', args: { ...base, changes: [{ path: 'a.ts', action: 'write', content: 'x' }, { action: 'write', content: 'y' }] }, expected: /changes\[1\][\s\S]*is missing "path"/ },
    { id: 'array-change', args: { ...base, changes: [[{ path: 'a.ts', action: 'write', content: 'x' }]] }, expected: /changes\[0\] is an array/ },
    { id: 'copy-no-revision', args: { ...base, changes: [{ path: 'mirror.txt', action: 'copy' }] }, expected: /changes\[0\][\s\S]*from/ },
    { id: 'copy-path-revision', args: { ...base, changes: [{ path: 'mirror.txt', action: 'copy', from: 'main:src/a.ts' }] }, expected: /changes\[0\][\s\S]*from[\s\S]*path/ },
    { id: 'blank-path', args: { ...base, changes: [{ path: '', action: 'delete' }] }, expected: /path/ },
    { id: 'scalar', args: 'not an object', expected: /valid|object|argument|schema/i },
  ];
  const observed = new Map<string, string>();
  let description = '';
  let stage = 0;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function: { name: string; description: string } }[]; messages: { role: string; content: unknown; tool_call_id?: string }[] };
    const main = body.tools?.some(tool => tool.function.name === 'apply_rsi_change') && body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('RSI shape public workflow'));
    let calls: { id: string; args: unknown }[] = [];
    if (main) {
      description = body.tools!.find(tool => tool.function.name === 'apply_rsi_change')!.function.description;
      for (const message of body.messages) if (message.role === 'tool' && message.tool_call_id) observed.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      if (stage === 0) calls = malformed;
      if (stage === 1) calls = [{ id: 'corrected', args: { ...base, changes: [
        { path: 'replace.txt', action: 'replace', edits: [{ oldText: 'original', newText: 'corrected' }] },
        { path: 'delete.txt', action: 'delete' },
        { path: 'mirror.txt', action: 'copy', from: initialCommit },
      ], checks: [check] } }];
      if (stage === 2) calls = [{ id: 'check-only', args: { ...base, changes: [], checks: [check] } }];
      stage++;
    }
    const delta = calls.length ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: 'apply_rsi_change', arguments: JSON.stringify(call.args) } })) }
      : { role: 'assistant', content: main ? 'RSI shape workflow completed' : 'No suggestion' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const webDir = join(root, 'web'); await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: checkout }], access: fullAccessPolicy(), credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } }, models: { entries: [{ id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' }] } }));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_RSI_ROOT: checkout, GRAPH_LOCAL_KEY: 'rsi-synthetic' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ projectId: 'p', model: 'local', text: 'RSI shape public workflow', requestId: 'rsi-shape' }) });
  expect(response.status).toBe(200);
  const created = await response.json() as { conversationId: string };
  await expect.poll(() => observed.has('check-only'), { timeout: 40000 }).toBe(true);
  expect(description).toContain('"copy"');
  for (const row of malformed) expect(observed.get(row.id), row.id).toMatch(row.expected);
  expect(observed.get('blank-path')).not.toContain('is missing');
  expect(observed.get('scalar')).not.toContain('nested');
  expect(observed.get('corrected')).toContain('applied');
  expect(observed.get('check-only')).toContain('没有产生提交');
  expect(await readFile(join(checkout, 'replace.txt'), 'utf8')).toBe('corrected\n');
  await expect(readFile(join(checkout, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(checkout, 'mirror.txt'), 'utf8')).toBe('revision content\n');
  expect(git(['log', '--format=%s', '-1'])).toBe('rsi: Correct native RSI call');
  expect(git(['rev-list', '--count', 'HEAD'])).toBe('2');
  expect(git(['status', '--porcelain'])).toBe('');
  const view = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}`, { headers })).json() as { messages: { kind: string; data?: { status: string; validation?: { status: string }[] } }[] };
  expect(view.messages.some(message => message.kind === 'rsi' && message.data?.status === 'applied' && message.data.validation?.every(check => check.status === 'passed'))).toBe(true);
}, 90000);
