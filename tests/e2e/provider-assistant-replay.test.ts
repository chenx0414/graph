import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { anthropicServer } from '../fixtures/anthropic-server.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The assistant turn a model reads back is the turn it wrote.
 *
 * The daemon, the PiG kernel, the tool bodies and the persistence are the product's
 * own; only the provider is replaced. The recorded request bodies are therefore the
 * bodies a real provider would have received.
 */

interface WireMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  reasoning_content?: string;
}

test('an openai answer keeps its reasoning and its tool call for the next request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-assistant-replay-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const provider = await openaiServer([
    { thinking: 'The proof needs the harness marker in it.', tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }] },
    { text: 'The proof file is ready.' },
  ]);
  const daemon = await launchCli(root, { env: { GRAPH_ASSISTANT_REPLAY_KEY: 'synthetic-only' }, extraArgs: ['--execute'], configPath: await config(root, project, {
    id: 'main', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
    baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local',
  }) });
  try {
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Create proof.txt with harness-proof.', requestId: 'replay-openai' }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 30_000 }).toBe('succeeded');
    expect(await readFile(join(project, 'proof.txt'), 'utf8')).toBe('harness-proof');

    const second = provider.requests[1] as { messages: WireMessage[] };
    const assistant = second.messages.find(message => message.role === 'assistant');
    expect(assistant).toBeDefined();
    // The reasoning the provider wrote is the reasoning the model reads back.
    expect(assistant!.reasoning_content).toBe('The proof needs the harness marker in it.');
    // The tool call the provider made is the tool call the model reads back.
    expect(JSON.stringify(assistant!.tool_calls)).toContain('"bash"');
    // The tool result still answers that call.
    expect(second.messages.some(message => message.role === 'tool')).toBe(true);
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('an anthropic answer keeps its signed reasoning and its tool call for the next request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-assistant-replay-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  const provider = await anthropicServer([
    { thinking: 'The proof needs the harness marker in it.', signature: 'sig-fixture-1',
      tool: { id: 'tool-write', name: 'bash', input: { command: 'printf harness-proof > proof.txt' } } },
    { text: 'The proof file is ready.' },
  ]);
  const daemon = await launchCli(root, { env: { GRAPH_ASSISTANT_REPLAY_KEY: 'synthetic-only' }, extraArgs: ['--execute'], configPath: await config(root, project, {
    id: 'main', modelId: 'claude-fixture', provider: 'anthropic', grade: 'high', api: 'anthropic-messages',
    baseUrl: provider.baseUrl, contextWindow: 200_000, maxTokens: 1_024, credentialId: 'local',
  }) });
  try {
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Create proof.txt with harness-proof.', requestId: 'replay-anthropic' }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 30_000 }).toBe('succeeded');
    expect(await readFile(join(project, 'proof.txt'), 'utf8')).toBe('harness-proof');

    const second = provider.requests[1]!.body as { messages: { role: string; content: { type: string; [key: string]: unknown }[] }[] };
    const assistant = second.messages.find(message => message.role === 'assistant');
    expect(assistant).toBeDefined();
    const blocks = assistant!.content as { type: string; [key: string]: unknown }[];
    // The signed reasoning comes back with the signature the provider signed it with.
    expect(blocks.find(block => block.type === 'thinking')).toMatchObject({ thinking: 'The proof needs the harness marker in it.', signature: 'sig-fixture-1' });
    // The tool call comes back as the tool use its result answers.
    expect(blocks.find(block => block.type === 'tool_use')).toMatchObject({ id: 'tool-write', name: 'bash' });
    // The tool result still answers that call.
    expect(JSON.stringify(second.messages)).toContain('tool_result');
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

async function config(root: string, project: string, model: Record<string, unknown>) {
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_ASSISTANT_REPLAY_KEY' } },
    models: { entries: [model] },
  }));
  return configPath;
}
