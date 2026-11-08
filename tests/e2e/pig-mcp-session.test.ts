import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
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
// There is one path and it lives in the kernel: the daemon reads the bound
// capability, the kernel connects the server itself, and the model calls the
// server's tool directly under PiG's own `mcp__<server>__<tool>` names. The
// retired pi-mcp-adapter extension (bus event, gateway tool named "mcp") is
// asserted gone by the assertions below.
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

// The built-in MCP extension is retired with the channel it carried.
//
// The old path was an npm extension that listened on a bus event and gave
// the model a gateway tool. The product must not carry it any more: it is
// not installed, and nothing in the product can register an MCP server at
// runtime. The kernel connects the server itself, which is the only way a
// server reaches the model now.
test('the product carries no MCP extension of its own', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(Object.keys(manifest.dependencies ?? {})).not.toContain('pi-mcp-adapter');
  expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('pi-mcp-adapter');

  // The registration event was the extension's only way in. With it gone, no
  // product source can hand a server to an extension.
  const sources = await collect(join(process.cwd(), 'src'), join(process.cwd(), 'backend'));
  for (const file of sources) {
    const body = await readFile(file, 'utf8');
    expect(body, `${file} still registers MCP servers at runtime`).not.toContain('pi-mcp-adapter:runtime-register:v1');
  }
});

// collect is every source file under the given roots.
async function collect(...roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) files.push(...await collect(path));
      else if (/\.(ts|tsx|mjs|go)$/.test(entry.name)) files.push(path);
    }
  }
  return files;
}
