import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const run = promisify(execFile);

// A real MCP server, speaking the protocol over stdio. It is an external
// service the kernel talks to, not a stand-in for one of Graph's own parts:
// the handshake, the tool list and the tool call all cross a process boundary.
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

// The MCP channel is native to the kernel: the model calls the server's tool
// under PiG's own name, and the server answers over the protocol. No adapter
// extension, no gateway tool and no event bus stand between them.
test('the PiG kernel calls an MCP server through the native channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-mcp-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const serverPath = join(root, 'mcp-server.mjs');
  await writeFile(serverPath, mcpServerSource);
  const provider = await openaiServer([
    { tools: [{ id: 'count-words', name: 'mcp__wordcount__word_count', arguments: JSON.stringify({ text: 'the quick brown fox' }) }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
    { text: 'The text has 4 words.', usage: { prompt_tokens: 30, completion_tokens: 8 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_MCP_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_MCP_KEY: 'synthetic-only' } });
    await daemon.close();
    daemon = undefined;

    const mcpPath = join(root, 'mcp.json');
    await writeFile(mcpPath, JSON.stringify({ servers: [{ name: 'wordcount', command: process.execPath, args: [serverPath] }] }));

    const database = join(root, 'state/tasks.sqlite');
    const binary = ensureBackendBinary();
    const turned = await run(binary, ['--pig-kernel-turn', database, '--config', configPath,
      '--kernel-model', 'main', '--kernel-prompt', 'Count the words of "the quick brown fox".',
      '--kernel-identity', 'mcp-instance', '--kernel-mcp', mcpPath],
      { env: { ...process.env, GRAPH_PIG_MCP_KEY: 'synthetic-only' }, timeout: 120_000 });
    const result = JSON.parse(turned.stdout.trim()) as {
      conversationId: number; status: string; text: string; toolCalls: string[]; entries: number;
    };
    expect(result.status).toBe('done');
    // The server's tool is declared to the model by its native name.
    const declared = provider.requests[0] as { tools?: { function?: { name?: string } }[] };
    expect((declared.tools ?? []).map(tool => tool.function?.name)).toContain('mcp__wordcount__word_count');
    // The model called the server's own tool, under the native name.
    expect(result.toolCalls).toContain('mcp__wordcount__word_count');
    // The server's answer reached the model and the model used it.
    expect(result.text).toContain('4 words');

    // The turn is in the Graph database.
    const evidence = new DatabaseSync(database, { readOnly: true });
    try {
      expect((evidence.prepare('SELECT COUNT(*) AS n FROM graph_durable_submissions').get() as { n: number }).n).toBeGreaterThan(0);
    } finally { evidence.close(); }
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
