import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * Why a tool call failed.
 *
 * A tool call that fails has to say why, in the node's own record. A boolean
 * cannot be diagnosed: an Agent that reads "the call failed" learns nothing
 * about the path that was missing or the permission that was refused, and a
 * ten-minute failure cannot depend on the Agent having narrated its own
 * mistake in the next sentence.
 *
 * The proof is a real node in a real graph. The model asks to read a file that
 * is not there, and the record the runtime wrote is read back over HTTP.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall { id: string; name: string; args: unknown }

/** The master Agent. It creates the graph and hands the work to the node. */
async function masterProvider(plan: (graphId: string) => MasterCall[]) {
  const results = new Map<string, string>();
  const served = new Map<string, string>();
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? '';
      if (base) results.set(base, content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan(graphId).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The node is done.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    served.set(next.id, next.id);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    graphId: () => graphId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The node model. It asks for a file that is not there, then says so. */
async function nodeProvider() {
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    // The model asks to read a file that does not exist: the tool fails for a
    // reason worth knowing.
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    if (!spoken.has('bad-read')) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bad-read', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ path: 'no/such/lane-notes.md' }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'That file does not exist.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 10 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a failed tool call leaves its reason in the node record, readable afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-tool-failure-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const master = await masterProvider(graphId => [
    { id: 'create', name: 'graph_create', args: {
      requestId: 'create',
      definition: {
        schemaVersion: 2, name: 'Tool failure', protocols: {},
        nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Read the lane notes', inputs: {}, outputs: {}, submission: {} } },
        modules: {}, edges: {}, inputs: {}, outputs: {},
      },
    } },
    { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Read the lane notes' } },
  ]);
  const node = await nodeProvider();
  const configPath = join(root, 'graph.config.json');
  const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'failure' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { failure: { secretRef: 'GRAPH_FAILURE_KEY' } },
    models: { entries: [
      { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...entry, id: 'local', provider: 'graph-node', modelId: 'node-model', baseUrl: node.baseUrl, contextWindow: 32000 },
    ] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_FAILURE_KEY: 'failure-synthetic' }, extraArgs: ['--execute'] });
  const created = await daemon.request('/api/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Make a tool call fail.', requestId: 'failure-begin' }),
  });
  expect(created.status).toBe(200);
  await expect.poll(() => master.results.get('send'), { timeout: 120_000, interval: 250 }).toBeTruthy();
  const graphId = master.graphId();
  expect(graphId).toBeTruthy();

  // The node's own record is readable afterwards.
  const entries: { kind: string; text: string; data?: { isError?: boolean; message?: string } }[] = [];
  await expect.poll(async () => {
    const view = await daemon.request(`/api/tasks/${graphId}/nodes/work/run`);
    const body = await view.json() as { entries?: typeof entries };
    entries.length = 0;
    entries.push(...(body.entries ?? []));
    return entries.filter(entry => entry.kind === 'result').length;
  }, { timeout: 120_000, interval: 250 }).toBeGreaterThan(0);

  const results = entries.filter(entry => entry.kind === 'result');
  const failed = results.filter(entry => entry.data?.isError === true);
  expect(failed.length, JSON.stringify(results)).toBe(1);

  // The record names the failure instead of only flagging it: a boolean
  // cannot be diagnosed.
  expect(failed[0]!.text).not.toBe('工具执行失败');
  expect(typeof failed[0]!.data?.message).toBe('string');
  expect((failed[0]!.data?.message ?? '').length).toBeGreaterThan(0);
  expect(failed[0]!.text).toContain(failed[0]!.data!.message!.slice(0, 20));

  // A call that succeeded is not dressed up as a failure.
  for (const entry of results.filter(item => !/失败/.test(item.text))) {
    expect(entry.data?.isError).not.toBe(true);
  }
  await daemon.close();
  await master.close();
  await node.close();
  await rm(root, { recursive: true, force: true });
}, 300_000);
