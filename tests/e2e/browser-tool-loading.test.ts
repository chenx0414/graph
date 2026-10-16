import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// Requires a real installed third-party Pi browser package and agent-browser.
// No replacement extension supplies the browser result in this test.
const browserSource = process.env.GRAPH_BROWSER_EXTENSION_SOURCE;
test.skipIf(!browserSource).each([false, true])('real browser executes after discovery and restart (deferred=%s)', async deferred => {
  const root = await mkdtemp(join(tmpdir(), 'graph-browser-loading-'));
  const previous = process.env.GRAPH_DEFER_BROWSER_TOOLS;
  process.env.GRAPH_DEFER_BROWSER_TOOLS = deferred ? '1' : '0';
  const page = createServer((_request, response) => { response.end('<!doctype html><title>Graph browser discovery proof</title><h1>Ready</h1>'); });
  await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(page.address() as AddressInfo).port}`;
  const browse = () => ({ tools: [{ id: 'browser-proof', name: 'agent_browser', arguments: JSON.stringify({
    args: ['batch', '--bail'], stdin: JSON.stringify([['open', url], ['get', 'title'], ['close']]), sessionMode: 'fresh', timeoutMs: 35000,
  }) }] });
  const provider = await openaiServer([
    ...(deferred ? [{ tools: [{ id: 'discover-browser', name: 'load_browser_tools', arguments: '{}' }] }] : []),
    browse(), { text: 'Browser verified.' }, browse(), { text: 'Browser verified after restart.' },
  ]);
  const graphHome = join(root, 'graph');
  const capability = join(graphHome, 'capabilities', 'browser'); await mkdir(capability, { recursive: true });
  const pkg = JSON.parse(await readFile(join(browserSource!, 'package.json'), 'utf8')) as { version: string };
  await writeFile(join(capability, 'capability.json'), JSON.stringify({ id: 'browser', kind: 'pi-extension', version: pkg.version,
    name: 'Installed real browser', source: browserSource, base: true,
    runtime: {commands:['agent-browser'],env:{PATH:process.env.PATH,HOME:process.env.HOME},networkAccess:'unrestricted'},
    tools: [{ name: 'agent_browser', description: 'Browse live websites.' }],
  }));
  const webDir = join(root, 'web'); await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<!doctype html>');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_BROWSER_TEST_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const options = { configPath, stateDir: join(root, 'state'), graphHome, webDir, port: 0, mode: 'execute' as const,
    dynamic: true, env: { ...process.env, GRAPH_BROWSER_TEST_KEY: 'fixture-key' }, log: () => undefined };
  let daemon = await startGraphDaemon(options);
  const auth = async () => {
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    return { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  };
  try {
    const headers = await auth();
    const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Open the local browser page and verify its title.', requestId: 'begin' }) });
    expect(response.status).toBe(200);
    const { conversationId } = await response.json() as { conversationId: string };
    const answered = async (headers: Record<string, string>, count: number) => {
      await expect.poll(async () => {
        const view = await (await fetch(`${daemon.url}/api/conversations/${conversationId}`, { headers })).json();
        return view.messages.filter((message: { role: string }) => message.role === 'assistant').length;
      }, { timeout: 60000 }).toBe(count);
    };
    await answered(headers, 1);
    const names = (index: number) => (provider.requests[index] as { tools: { function: { name: string } }[] }).tools.map(tool => tool.function.name);
    expect(names(0).includes('agent_browser')).toBe(!deferred);
    expect(names(0).includes('load_browser_tools')).toBe(deferred);
    if (deferred) expect(names(1)).toContain('agent_browser');
    const answerIndex = deferred ? 2 : 1;
    const toolText = (index: number) => (provider.requests[index] as {messages:{role:string;content:unknown}[]}).messages.filter(message=>message.role==='tool').map(message=>message.content);
    expect(JSON.stringify(toolText(answerIndex))).toContain('Graph browser discovery proof');
    await daemon.close(); daemon = await startGraphDaemon(options);
    const restored = await auth();
    expect((await fetch(`${daemon.url}/api/conversations/${conversationId}/messages`, { method: 'POST', headers: restored,
      body: JSON.stringify({ text: 'Check the title again.', requestId: 'again' }) })).status).toBe(200);
    await answered(restored, 2);
    expect(names(answerIndex + 1)).toContain('agent_browser');
    expect(JSON.stringify(toolText(answerIndex + 2))).toContain('Graph browser discovery proof');
  } finally {
    await daemon.close(); await provider.close();
    page.closeAllConnections(); await new Promise<void>(resolve => page.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.GRAPH_DEFER_BROWSER_TOOLS; else process.env.GRAPH_DEFER_BROWSER_TOOLS = previous;
  }
}, 150000);
