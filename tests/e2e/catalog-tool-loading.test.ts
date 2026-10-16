import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('HTTP catalog discovery activates bound tools and survives a daemon restart', async () => {
  const previous = process.env.GRAPH_DEFER_CATALOG_TOOLS;
  process.env.GRAPH_DEFER_CATALOG_TOOLS = '1';
  const root = await mkdtemp(join(tmpdir(), 'graph-catalog-loading-'));
  const call = (name: string, id: string) => ({ tools: [{ id, name, arguments: '{}' }] });
  const provider = await openaiServer([
    call('load_catalog_tools', 'load'), call('list_agent_combinations', 'list'), { text: 'Catalog inspected.' },
    call('list_agent_combinations', 'restored-list'), { text: 'Catalog inspected after restart.' },
  ]);
  const webDir = join(root, 'web'); await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const options = { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    port: 0, mode: 'execute' as const, dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: 'fixture-key' }, log: () => undefined };
  let daemon = await startGraphDaemon(options);
  const headers = async () => {
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    return { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  };
  try {
    const auth = await headers();
    const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers: auth,
      body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Inspect available agent combinations.', requestId: 'create' }) });
    expect(response.status).toBe(200);
    const created = await response.json() as { conversationId: string };
    const answered = async (auth: Record<string, string>, count: number) => {
      await expect.poll(async () => {
        const view = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}`, { headers: auth })).json();
        return view.messages.filter((message: { role: string }) => message.role === 'assistant').length;
      }, { timeout: 20000 }).toBe(count);
    };
    await answered(auth, 1);
    const names = (index: number) => ((provider.requests[index] as { tools: { function: { name: string } }[] }).tools).map(tool => tool.function.name);
    expect(names(0)).toContain('load_catalog_tools');
    expect(names(0)).not.toContain('list_agent_combinations');
    expect(names(1), JSON.stringify((provider.requests[1] as { messages: { role: string }[] }).messages.filter(message => message.role === 'tool'))).toContain('list_agent_combinations');
    expect(names(0)).toEqual(expect.arrayContaining(['read', 'bash', 'graph_create', 'graph_send']));
    // The actual catalog tool executes, rather than receiving a fabricated loader result.
    const messages = (provider.requests[2] as { messages: { role: string; name?: string; content: string }[] }).messages;
    const result = messages.filter(message => message.role === 'tool').at(-1)!;
    expect(result.content).not.toMatch(/unknown tool|not found|not available/i);
    await daemon.close(); daemon = await startGraphDaemon(options);
    const restored = await headers();
    expect((await fetch(`${daemon.url}/api/conversations/${created.conversationId}/messages`, { method: 'POST', headers: restored,
      body: JSON.stringify({ text: 'Inspect them again.', requestId: 'again' }) })).status).toBe(200);
    await answered(restored, 2);
    expect(names(3)).toContain('list_agent_combinations');
  } finally {
    await daemon.close(); await provider.close(); await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.GRAPH_DEFER_CATALOG_TOOLS; else process.env.GRAPH_DEFER_CATALOG_TOOLS = previous;
  }
}, 60000);
