import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A real MCP server, speaking the protocol over stdio. It is an external
// service the daemon talks to, not a stand-in for one of Graph's own parts.
const mcpServerSource = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'graph-e2e-mcp', version: '1.0.0' } } });
    continue;
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'word_count', description: 'Count the words of a text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
    continue;
  }
  if (request.method === 'tools/call') {
    const text = String(request.params?.arguments?.text ?? '');
    const words = text.trim().split(/\\s+/).filter(Boolean).length;
    send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: words + ' words' }] } });
    continue;
  }
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } });
}
`;

// The MCP servers of a Graph definition reach the model through the kernel's
// own native channel.
//
// The old path was an extension: pi-mcp-adapter listened on a bus event, the
// servers arrived as a gateway tool, and the model called "mcp" with a server
// name inside. The new path has no gateway and no extension: the kernel
// connects the server itself and offers its tools under PiG's own
// `mcp__<server>__<tool>` names, so the model calls the server's tool
// directly.
test('a bound MCP server reaches the model through the PiG native channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-mcp-session-'));
  const project = join(root, 'project');
  const home = join(root, 'graph-home');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await mkdir(home);
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const serverPath = join(root, 'mcp-server.mjs');
  await writeFile(serverPath, mcpServerSource);

  // The capability the definition binds: a real MCP server over stdio.
  const capabilityDirectory = join(home, 'capabilities', 'mcp', 'wordcount-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'capability.json'), JSON.stringify({
    id: 'wordcount', kind: 'mcp', version: '1.0.0', name: 'Word count',
    command: process.execPath, args: [serverPath],
  }));
  // The recipe the master definition is compiled from.
  await writeFile(join(home, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main', name: 'Main', description: 'The main agent with an MCP server.',
      recommendedGrade: 'high', review: false, tags: [],
      resources: [{ resourceId: 'wordcount', version: '1.0.0', role: 'mcp', required: false }],
    }],
  }));

  const provider = await openaiServer([
    { tools: [{ id: 'count-words', name: 'mcp__wordcount__word_count', arguments: JSON.stringify({ text: 'the quick brown fox' }) }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
    { text: 'The text has 4 words.', usage: { prompt_tokens: 30, completion_tokens: 8 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_MCP_SESSION_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_MCP_SESSION_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });

    // The recipe is compiled into the definition the master agent runs.
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);
    const definition = await compiled.json() as { definitionId: string; definitionVersion: string };
    expect(definition.definitionId).toBe('main');

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Count the words of "the quick brown fox".', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json();
    await expect.poll(async () => (await view()).master?.status, { timeout: 30000 }).toBe('succeeded');
    const answers = (await view()).messages.filter((message: { role: string }) => message.role === 'assistant');
    expect(answers.at(-1)?.text).toContain('4 words');

    // The server's tool is declared to the model under its native name: no
    // gateway tool, no adapter extension.
    const declared = provider.requests[0] as { tools?: { function?: { name?: string } }[] };
    const names = (declared.tools ?? []).map(tool => tool.function?.name);
    expect(names).toContain('mcp__wordcount__word_count');
    expect(names).not.toContain('mcp');
    // The model called the server's own tool, and the server's answer came
    // back over the protocol.
    expect(JSON.stringify(provider.requests[1])).toContain('4 words');

    // The turn is in the Graph database, written by the PiG kernel.
    const evidence = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
    try {
      expect((evidence.prepare('SELECT COUNT(*) AS n FROM graph_durable_submissions').get() as { n: number }).n).toBeGreaterThan(0);
      expect((evidence.prepare('SELECT version FROM graph_durable_durable_schema WHERE singleton=1').get() as { version: number }).version).toBe(2);
    } finally { evidence.close(); }
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
